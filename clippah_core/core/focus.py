"""
Intelligent subject & active-speaker framing for vertical 9:16 exports.

Uses zero-dependency FFmpeg frame sampling + temporal motion, edge contrast,
and warm foreground/skin cues to locate the active speaker or primary action
across a clip and generate smooth FFmpeg crop expressions—eliminating crops
centered on empty background space.
"""

from __future__ import annotations

from pathlib import Path
import statistics
import subprocess
from typing import List, Optional, Tuple

from .schemas import AspectRatio, FocusConfig, FocusKeyframe, FocusMode


def score_rgb_frame_columns(
    curr_rgb: bytes,
    prev_rgb: Optional[bytes],
    width: int,
    height: int,
) -> List[float]:
    """
    Compute per-column visual attention scores from raw RGB24 bytes.

    Combines:
      1. Temporal motion energy (active speaker gestures / mouth / movement)
      2. Local edge contrast (foreground subject detail vs flat empty walls)
      3. Skin-tone / warm foreground cues (human faces & hands)
      4. Vertical upper-middle weighting (where speakers & main action sit)
    """
    if width <= 0 or height <= 0 or len(curr_rgb) < width * height * 3:
        return [0.0] * max(1, width)

    has_prev = prev_rgb is not None and len(prev_rgb) >= width * height * 3
    scores = [0.0] * width

    y_start = max(0, int(height * 0.08))
    y_end = min(height, int(height * 0.85))
    row_stride = width * 3

    for y in range(y_start, y_end):
        # Slightly emphasize upper-middle region (y ~ 20%..65%) where faces/action appear
        y_norm = y / max(1, height - 1)
        row_weight = 1.35 if 0.16 <= y_norm <= 0.65 else 0.85
        row_off = y * row_stride

        for x in range(width):
            idx = row_off + x * 3
            r = curr_rgb[idx]
            g = curr_rgb[idx + 1]
            b = curr_rgb[idx + 2]

            # Spatial horizontal edge contrast (ignores uniform empty background)
            edge = 0.0
            if x > 0:
                l_idx = idx - 3
                edge = (
                    abs(r - curr_rgb[l_idx])
                    + abs(g - curr_rgb[l_idx + 1])
                    + abs(b - curr_rgb[l_idx + 2])
                ) / 3.0

            # Temporal motion delta
            motion = 0.0
            if has_prev and prev_rgb is not None:
                motion = (
                    abs(r - prev_rgb[idx])
                    + abs(g - prev_rgb[idx + 1])
                    + abs(b - prev_rgb[idx + 2])
                ) / 3.0

            # Warm skin / foreground speaker heuristic
            skin_bonus = 0.0
            if r > 90 and g > 38 and b > 18 and r > g and r > b and (r - g) >= 12 and (max(r, g, b) - min(r, g, b)) >= 18:
                skin_bonus = 48.0

            # Ignore dead-dark / near-blank background pixels with zero detail
            luma = 0.299 * r + 0.587 * g + 0.114 * b
            detail = edge * 1.1 + motion * 2.4 + skin_bonus
            if luma < 14 and motion < 5 and edge < 4:
                detail *= 0.1

            scores[x] += detail * row_weight

    norm_div = max(1, y_end - y_start)
    return [round(s / norm_div, 4) for s in scores]


def find_best_focus_x(
    col_scores: List[float],
    crop_width_ratio: float = 0.3164,
) -> Tuple[float, float]:
    """
    Find normalized horizontal focus center [0..1] maximizing attention inside
    a 9:16 vertical crop window, avoiding empty space.
    """
    width = len(col_scores)
    if width <= 1:
        return 0.5, 0.5

    safe_ratio = max(0.15, min(0.95, float(crop_width_ratio)))
    win = max(2, min(width, int(round(width * safe_ratio))))
    if win >= width:
        return 0.5, 0.8

    # Prefix sums for O(W) sliding-window evaluation
    prefix = [0.0] * (width + 1)
    for i, val in enumerate(col_scores):
        prefix[i + 1] = prefix[i] + val

    best_start = max(0, (width - win) // 2)
    best_sum = -1.0
    total_sum = prefix[width]

    for start in range(0, width - win + 1):
        w_sum = prefix[start + win] - prefix[start]
        # Tiny center tie-breaker (0.5%) only when two regions are identically active
        center_norm = (start + win / 2.0) / width
        tie_break = 1.0 - 0.015 * abs(center_norm - 0.5)
        weighted = w_sum * tie_break
        if weighted > best_sum:
            best_sum = weighted
            best_start = start

    # Weighted centroid within the winning crop window so subject stays dead-on
    win_slice = col_scores[best_start : best_start + win]
    win_total = sum(win_slice)
    if win_total <= 1e-6:
        return 0.5, 0.35

    centroid_idx = sum((best_start + idx + 0.5) * val for idx, val in enumerate(win_slice)) / win_total
    raw_center_norm = centroid_idx / width
    half_win = safe_ratio / 2.0
    clamped_center = max(half_win, min(1.0 - half_win, raw_center_norm))

    avg_col = total_sum / width if width > 0 else 0.0
    peak_avg = win_total / win
    ratio = peak_avg / max(1e-4, avg_col) if avg_col > 0 else 1.0
    confidence = max(0.4, min(0.99, 0.45 + 0.25 * min(2.2, ratio)))

    return round(clamped_center, 4), round(confidence, 3)


def _describe_horizontal_zone(x_norm: float) -> str:
    if x_norm < 0.38:
        return "Subject left"
    if x_norm > 0.62:
        return "Subject right"
    return "Subject center"


def smooth_and_simplify_keyframes(
    raw_points: List[Tuple[float, float, float, str]],
    smoothing: float = 0.75,
    max_keyframes: int = 10,
) -> List[FocusKeyframe]:
    """Smooth jitter across frames and emit compact piecewise keyframes."""
    if not raw_points:
        return [FocusKeyframe(time_sec=0.0, x_norm=0.5, y_norm=0.45, confidence=0.5, label="Center default")]

    alpha = max(0.15, min(0.85, 1.0 - smoothing * 0.65))
    smoothed: List[Tuple[float, float, float, str]] = []
    cur_x = raw_points[0][1]

    for t, target_x, conf, label in raw_points:
        delta = abs(target_x - cur_x)
        # Deadband: ignore tiny <4% micro-shifts so camera feels locked on speaker
        if delta >= 0.04:
            # Faster snap on scene/speaker switches (>20% jump), gentle pan otherwise
            step_alpha = min(0.92, alpha * 1.9) if delta >= 0.20 else alpha
            cur_x = cur_x + step_alpha * (target_x - cur_x)
        smoothed.append((round(t, 3), round(cur_x, 4), conf, label or _describe_horizontal_zone(cur_x)))

    # Keep start, end, and significant directional transitions
    compact: List[FocusKeyframe] = []
    for idx, (t, x, conf, label) in enumerate(smoothed):
        if idx == 0 or idx == len(smoothed) - 1:
            compact.append(FocusKeyframe(time_sec=t, x_norm=x, y_norm=0.45, confidence=conf, label=label))
            continue
        prev_x = compact[-1].x_norm
        if abs(x - prev_x) >= 0.055 and (t - compact[-1].time_sec) >= 0.4:
            compact.append(FocusKeyframe(time_sec=t, x_norm=x, y_norm=0.45, confidence=conf, label=label))

    if len(compact) > max_keyframes:
        step = (len(compact) - 1) / (max_keyframes - 1)
        compact = [compact[int(round(i * step))] for i in range(max_keyframes)]

    return compact


def analyze_clip_focus(
    video_path: Path,
    start_sec: float,
    end_sec: float,
    ffmpeg_bin: str = "ffmpeg",
    crop_width_ratio: float = 0.3164,
) -> FocusConfig:
    """
    Sample compact RGB frames via FFmpeg and track the active speaker / main action.
    """
    start = max(0.0, float(start_sec))
    duration = max(0.5, float(end_sec) - start)
    sample_w, sample_h = 128, 72
    frame_bytes = sample_w * sample_h * 3

    target_frames = min(24, max(4, int(round(duration * 1.6))))
    sample_fps = max(0.5, min(2.5, target_frames / duration))

    cmd = [
        ffmpeg_bin,
        "-v",
        "error",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(video_path),
        "-vf",
        f"fps={sample_fps:.3f},scale={sample_w}:{sample_h}",
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, check=False, timeout=15)
    except Exception:
        return FocusConfig(
            mode=FocusMode.SMART_AUTO,
            target_x=0.5,
            smoothing=0.75,
            keyframes=[FocusKeyframe(time_sec=0.0, x_norm=0.5, y_norm=0.45, confidence=0.4, label="Center fallback")],
            source="ffmpeg-fallback",
        )

    raw_buf = proc.stdout or b""
    num_frames = len(raw_buf) // frame_bytes
    if num_frames == 0:
        return FocusConfig(
            mode=FocusMode.SMART_AUTO,
            target_x=0.5,
            smoothing=0.75,
            keyframes=[FocusKeyframe(time_sec=0.0, x_norm=0.5, y_norm=0.45, confidence=0.4, label="Center fallback")],
            source="ffmpeg-fallback",
        )

    raw_points: List[Tuple[float, float, float, str]] = []
    prev_frame: Optional[bytes] = None
    dt = duration / max(1, num_frames)

    for idx in range(num_frames):
        offset = idx * frame_bytes
        frame = raw_buf[offset : offset + frame_bytes]
        col_scores = score_rgb_frame_columns(frame, prev_frame, sample_w, sample_h)
        x_norm, conf = find_best_focus_x(col_scores, crop_width_ratio=crop_width_ratio)
        t_rel = min(duration, idx * dt)
        raw_points.append((t_rel, x_norm, conf, _describe_horizontal_zone(x_norm)))
        prev_frame = frame

    keyframes = smooth_and_simplify_keyframes(raw_points, smoothing=0.75)
    median_x = round(statistics.median([kf.x_norm for kf in keyframes]), 4)
    return FocusConfig(
        mode=FocusMode.SMART_AUTO,
        target_x=median_x,
        smoothing=0.75,
        keyframes=keyframes,
        source="ffmpeg-motion-saliency",
    )


def build_ffmpeg_crop_x_expr(
    focus: Optional[FocusConfig],
    target_aspect: AspectRatio = AspectRatio.VERTICAL_9_16,
) -> str:
    """
    Build a per-frame FFmpeg crop X expression `t`-parameterized over clip duration.
    Result is safe inside single-quoted `-vf crop=...:0`.
    """
    if target_aspect != AspectRatio.VERTICAL_9_16:
        return "(iw-ow)/2"

    if focus is None:
        return "(iw-ow)/2"

    if focus.mode == FocusMode.CENTER:
        return "(iw-ow)/2"

    kfs = sorted(focus.keyframes, key=lambda k: k.time_sec) if focus.keyframes else []
    if focus.mode == FocusMode.MANUAL or len(kfs) <= 1:
        x_val = focus.target_x if (focus.mode == FocusMode.MANUAL or not kfs) else kfs[0].x_norm
        x_val = max(0.0, min(1.0, float(x_val)))
        return f"clip(iw*{x_val:.4f}-ow/2,0,iw-ow)"

    # Cap to <= 10 segments so FFmpeg expression stays clean & fast
    if len(kfs) > 10:
        step = (len(kfs) - 1) / 9.0
        kfs = [kfs[int(round(i * step))] for i in range(10)]

    # Build nested piecewise linear interpolation:
    # if(lt(t, t1), x0 + (x1-x0)*(t-t0)/(t1-t0), ...)
    expr = f"{kfs[-1].x_norm:.4f}"
    for i in range(len(kfs) - 2, -1, -1):
        t0 = max(0.0, float(kfs[i].time_sec))
        t1 = max(t0 + 0.05, float(kfs[i + 1].time_sec))
        x0 = max(0.0, min(1.0, float(kfs[i].x_norm)))
        x1 = max(0.0, min(1.0, float(kfs[i + 1].x_norm)))
        dt = t1 - t0
        dx = x1 - x0
        if abs(dx) < 0.002:
            seg_expr = f"{x0:.4f}"
        elif abs(dx) >= 0.28 and dt <= 0.6:
            # Fast cut between distant speakers rather than blurry pan
            seg_expr = f"{x0:.4f}"
        else:
            seg_expr = f"({x0:.4f}+({dx:.4f})*max(0,t-{t0:.3f})/{dt:.3f})"
        expr = f"if(lt(t,{t1:.3f}),{seg_expr},{expr})"

    return f"clip(iw*({expr})-ow/2,0,iw-ow)"
