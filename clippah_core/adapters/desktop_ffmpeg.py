"""
Desktop VideoProcessor adapter backed by local FFmpeg & FFprobe.

Binary resolution order:
1. Explicit path passed to constructor
2. Bundled binaries next to frozen executable / Tauri resources (`bin/` or `resources/bin/`)
3. System PATH (`shutil.which`)

Android adaptation note: Replace subprocess ffmpeg/ffprobe calls with AndroidX
Media3 Transformer (hardware-accelerated MediaCodec H.264/HEVC encoding,
Presentation/Crop effects for 9:16, and OverlayEffect for burned-in captions)
to avoid shipping LGPL/GPL ffmpeg binaries and prevent thermal CPU throttling.
"""

from __future__ import annotations

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
from typing import Dict, List, Optional

from ..core.interfaces import ProgressCallback, VideoProcessor
from ..core.schemas import AspectRatio, EncodeMode, ExportResult, ExportSpec


def _subprocess_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


def resolve_media_binary(name: str) -> str:
    """Locate bundled Windows/macOS/Linux binary when packaged with PyInstaller or Tauri."""
    exe_suffix = ".exe" if os.name == "nt" else ""
    filename = name if name.endswith(exe_suffix) else f"{name}{exe_suffix}"

    search_roots: List[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        search_roots.extend([
            exe_dir,
            exe_dir / "bin",
            exe_dir / "resources" / "bin",
            exe_dir.parent / "resources" / "bin",
        ])
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            search_roots.extend([Path(meipass), Path(meipass) / "bin"])

    for root in search_roots:
        candidate = root / filename
        if candidate.is_file():
            return str(candidate)

    found = shutil.which(name) or shutil.which(filename)
    return found or name


class FFmpegVideoProcessor(VideoProcessor):
    def __init__(self, ffmpeg_bin: Optional[str] = None, ffprobe_bin: Optional[str] = None) -> None:
        self.ffmpeg_bin = ffmpeg_bin or resolve_media_binary("ffmpeg")
        self.ffprobe_bin = ffprobe_bin or resolve_media_binary("ffprobe")

    def _check_bin(self, binary: str) -> None:
        if Path(binary).is_file():
            return
        if shutil.which(binary) is None:
            raise RuntimeError(f"Required binary '{binary}' not found on PATH or bundled bin/.")

    def probe_media(self, media_path: Path) -> Dict[str, float | int | bool]:
        self._check_bin(self.ffprobe_bin)
        cmd = [
            self.ffprobe_bin,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(media_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, **_subprocess_kwargs())
        if proc.returncode != 0:
            raise RuntimeError(f"ffprobe failed: {proc.stderr.strip()}")

        data = json.loads(proc.stdout)
        streams = data.get("streams", [])
        video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

        fps_raw = str(video_stream.get("avg_frame_rate") or "30/1")
        if "/" in fps_raw:
            num, den = fps_raw.split("/", 1)
            fps = float(num) / max(1.0, float(den))
        else:
            fps = float(fps_raw)

        duration = float(data.get("format", {}).get("duration") or video_stream.get("duration") or 0.0)
        return {
            "duration_sec": round(duration, 3),
            "width": int(video_stream.get("width") or 1280),
            "height": int(video_stream.get("height") or 720),
            "fps": round(fps, 3),
            "has_audio": audio_stream is not None,
        }

    def extract_audio(self, video_path: Path, output_wav_path: Path) -> Path:
        self._check_bin(self.ffmpeg_bin)
        output_wav_path = Path(output_wav_path)
        output_wav_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(output_wav_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, **_subprocess_kwargs())
        if proc.returncode != 0:
            raise RuntimeError(f"Audio extraction failed: {proc.stderr.strip()}")
        return output_wav_path

    def render_clip(
        self,
        source_video: Path,
        spec: ExportSpec,
        srt_content: Optional[str] = None,
        ass_content: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ) -> ExportResult:
        self._check_bin(self.ffmpeg_bin)
        out_dir = Path(spec.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in spec.clip.id)
        ratio_tag = "9x16" if spec.aspect_ratio == AspectRatio.VERTICAL_9_16 else "16x9"
        base_name = f"{safe_id}_{ratio_tag}"

        video_out = out_dir / f"{base_name}.mp4"
        srt_out: Optional[Path] = None
        ass_out: Optional[Path] = None

        if srt_content is not None and spec.include_srt:
            srt_out = out_dir / f"{base_name}.srt"
            srt_out.write_text(srt_content, encoding="utf-8")

        if ass_content is not None and spec.burn_captions:
            ass_out = out_dir / f"{base_name}.ass"
            ass_out.write_text(ass_content, encoding="utf-8")

        start = max(0.0, spec.clip.start_sec)
        duration = max(0.5, spec.clip.end_sec - start)

        # Stream copy is only valid for 16:9 without video filter burn-in
        use_stream_copy = (
            spec.encode_mode == EncodeMode.STREAM_COPY
            and spec.aspect_ratio == AspectRatio.LANDSCAPE_16_9
            and not (spec.burn_captions and ass_out is not None)
        )

        cmd: List[str] = [
            self.ffmpeg_bin,
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(source_video),
            "-t",
            f"{duration:.3f}",
        ]

        if use_stream_copy:
            cmd.extend(["-c", "copy", "-avoid_negative_ts", "make_zero"])
        else:
            vf_filters: List[str] = []
            if spec.aspect_ratio == AspectRatio.VERTICAL_9_16:
                vf_filters.append("crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920")
            else:
                vf_filters.append("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2")

            if spec.burn_captions and ass_out is not None:
                escaped_ass = str(ass_out.resolve()).replace("\\", "/").replace(":", "\\:")
                vf_filters.append(f"ass='{escaped_ass}'")

            cmd.extend([
                "-vf",
                ",".join(vf_filters),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "21",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
            ])

        cmd.append(str(video_out))
        if on_progress:
            on_progress(0.35, "Running FFmpeg render...")

        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, **_subprocess_kwargs())
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg render failed: {proc.stderr[-800:]}")

        if on_progress:
            on_progress(1.0, "Export complete")

        return ExportResult(
            clip_id=spec.clip.id,
            video_path=str(video_out),
            srt_path=str(srt_out) if srt_out else None,
            ass_path=str(ass_out) if ass_out else None,
            aspect_ratio=spec.aspect_ratio,
            encode_mode=EncodeMode.STREAM_COPY if use_stream_copy else EncodeMode.REENCODE,
            duration_sec=round(duration, 3),
            file_size_bytes=video_out.stat().st_size,
        )
