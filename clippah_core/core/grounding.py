"""
Pure timestamp grounding & word-boundary snapping.

LLMs frequently emit approximate start/end timestamps (e.g. off by 0.4s-1.5s) that clip
the first syllable of a hook or leave trailing filler. This module snaps raw clip bounds
to the nearest spoken word boundaries in the cached word-level Transcript.
"""

from __future__ import annotations

from typing import List, Tuple

from .schemas import ClipCandidate, Transcript, WordTimestamp


def find_word_window(
    words: List[WordTimestamp],
    start_sec: float,
    end_sec: float,
    max_search_delta_sec: float = 2.0,
) -> Tuple[int, int]:
    """
    Locate inclusive (first_idx, last_idx) word indices that best bracket [start_sec, end_sec].
    """
    if not words:
        return (-1, -1)

    # First word whose midpoint or end lies inside or nearest after start_sec
    best_start_idx = 0
    best_start_dist = float("inf")
    for idx, w in enumerate(words):
        dist = abs(w.start_sec - start_sec)
        if w.start_sec <= start_sec <= w.end_sec:
            best_start_idx = idx
            best_start_dist = 0.0
            break
        if dist < best_start_dist and dist <= max_search_delta_sec:
            best_start_dist = dist
            best_start_idx = idx

    if best_start_dist == float("inf"):
        # Fallback to first word starting >= start_sec, or nearest word overall
        for idx, w in enumerate(words):
            if w.start_sec >= start_sec:
                best_start_idx = idx
                break

    best_end_idx = len(words) - 1
    best_end_dist = float("inf")
    for idx in range(best_start_idx, len(words)):
        w = words[idx]
        if w.start_sec <= end_sec <= w.end_sec:
            best_end_idx = idx
            best_end_dist = 0.0
            break
        dist = abs(w.end_sec - end_sec)
        if dist < best_end_dist and dist <= max_search_delta_sec:
            best_end_dist = dist
            best_end_idx = idx

    if best_end_dist == float("inf"):
        for idx in range(len(words) - 1, best_start_idx - 1, -1):
            if words[idx].end_sec <= end_sec:
                best_end_idx = idx
                break

    if best_end_idx < best_start_idx:
        best_end_idx = best_start_idx

    return (best_start_idx, best_end_idx)


def snap_clip_to_words(
    clip: ClipCandidate,
    transcript: Transcript,
    pre_roll_sec: float = 0.12,
    post_roll_sec: float = 0.22,
    min_pause_gap_sec: float = 0.35,
) -> ClipCandidate:
    """
    Snap a ClipCandidate's start_sec and end_sec to clean word boundaries, respecting
    natural breath pauses so sentences never clip mid-word.
    """
    words = transcript.all_words()
    if not words:
        return clip

    first_idx, last_idx = find_word_window(words, clip.start_sec, clip.end_sec)
    if first_idx < 0 or last_idx < 0:
        return clip

    # If the previous word ended within a tight phrase (< min_pause_gap_sec) and starts
    # slightly before our boundary, check if we are cutting mid-sentence; keep clean start.
    snapped_start = words[first_idx].start_sec - pre_roll_sec
    if first_idx > 0:
        prev_end = words[first_idx - 1].end_sec
        gap = words[first_idx].start_sec - prev_end
        if gap < pre_roll_sec * 2:
            # Split the gap cleanly so we don't bleed the previous word
            snapped_start = prev_end + (gap * 0.5)

    snapped_end = words[last_idx].end_sec + post_roll_sec
    if last_idx + 1 < len(words):
        next_start = words[last_idx + 1].start_sec
        gap = next_start - words[last_idx].end_sec
        if gap < post_roll_sec * 1.5:
            snapped_end = words[last_idx].end_sec + (gap * 0.5)

    snapped_start = round(max(0.0, snapped_start), 3)
    snapped_end = round(min(transcript.duration_sec, max(snapped_start + 1.0, snapped_end)), 3)

    data = clip.model_dump()
    data["start_sec"] = snapped_start
    data["end_sec"] = snapped_end
    data["snapped_to_words"] = True
    return ClipCandidate.model_validate(data)


def ground_and_deduplicate_clips(
    clips: List[ClipCandidate],
    transcript: Transcript,
    max_overlap_ratio: float = 0.65,
) -> List[ClipCandidate]:
    """
    Snap every clip to word boundaries, sort by hook_score descending, and suppress
    redundant overlapping candidates.
    """
    snapped = [snap_clip_to_words(c, transcript) for c in clips]
    snapped.sort(key=lambda c: c.hook_score, reverse=True)

    kept: List[ClipCandidate] = []
    for candidate in snapped:
        cand_dur = max(0.001, candidate.end_sec - candidate.start_sec)
        overlaps = False
        for existing in kept:
            inter = max(
                0.0,
                min(candidate.end_sec, existing.end_sec)
                - max(candidate.start_sec, existing.start_sec),
            )
            if inter / cand_dur >= max_overlap_ratio:
                overlaps = True
                break
        if not overlaps:
            kept.append(candidate)

    # Return chronologically ordered for timeline display
    kept.sort(key=lambda c: c.start_sec)
    return kept
