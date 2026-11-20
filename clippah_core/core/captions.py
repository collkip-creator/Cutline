"""
Pure SRT and ASS subtitle generator for clipped segments.

All timestamps are shifted relative to `clip.start_sec` (t=0 at clip start)
so exported .srt and .ass files match cut video files frame-accurately.
"""

from __future__ import annotations

from typing import List

from .schemas import AspectRatio, ClipCandidate, Transcript, WordTimestamp


def format_srt_timestamp(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def format_ass_timestamp(seconds: float) -> str:
    cs_total = max(0, int(round(seconds * 100)))
    hours, rem = divmod(cs_total, 360_000)
    minutes, rem = divmod(rem, 6_000)
    secs, cs = divmod(rem, 100)
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _group_words_into_phrases(
    words: List[WordTimestamp],
    clip_start: float,
    clip_end: float,
    max_words_per_line: int = 5,
    max_phrase_sec: float = 2.6,
) -> List[tuple[float, float, str]]:
    """Group word timestamps overlapping [clip_start, clip_end] into punchy subtitle lines."""
    clipped = [
        w for w in words if w.end_sec > clip_start and w.start_sec < clip_end
    ]
    if not clipped:
        return []

    phrases: List[tuple[float, float, str]] = []
    bucket: List[WordTimestamp] = []

    for word in clipped:
        if not bucket:
            bucket.append(word)
            continue
        span = word.end_sec - bucket[0].start_sec
        gap = word.start_sec - bucket[-1].end_sec
        ends_sentence = bucket[-1].word.endswith((".", "!", "?"))
        if len(bucket) >= max_words_per_line or span >= max_phrase_sec or gap >= 0.45 or ends_sentence:
            phrases.append((
                max(0.0, bucket[0].start_sec - clip_start),
                min(clip_end - clip_start, bucket[-1].end_sec - clip_start),
                " ".join(w.word for w in bucket),
            ))
            bucket = [word]
        else:
            bucket.append(word)

    if bucket:
        phrases.append((
            max(0.0, bucket[0].start_sec - clip_start),
            min(clip_end - clip_start, bucket[-1].end_sec - clip_start),
            " ".join(w.word for w in bucket),
        ))

    return phrases


def generate_srt(
    clip: ClipCandidate,
    transcript: Transcript,
    max_words_per_line: int = 6,
) -> str:
    phrases = _group_words_into_phrases(
        transcript.all_words(),
        clip.start_sec,
        clip.end_sec,
        max_words_per_line=max_words_per_line,
    )
    if not phrases:
        return (
            "1\n"
            f"00:00:00,000 --> {format_srt_timestamp(clip.duration_sec)}\n"
            f"{clip.caption_hook or clip.title}\n"
        )

    blocks: List[str] = []
    for idx, (s, e, text) in enumerate(phrases, start=1):
        blocks.append(f"{idx}\n{format_srt_timestamp(s)} --> {format_srt_timestamp(e)}\n{text}")
    return "\n\n".join(blocks) + "\n"


def generate_ass(
    clip: ClipCandidate,
    transcript: Transcript,
    aspect_ratio: AspectRatio = AspectRatio.VERTICAL_9_16,
    font_size: int = 44,
    include_hook_banner: bool = True,
) -> str:
    play_res_x, play_res_y = (1080, 1920) if aspect_ratio == AspectRatio.VERTICAL_9_16 else (1920, 1080)
    margin_v = 340 if aspect_ratio == AspectRatio.VERTICAL_9_16 else 95

    header = (
        "[Script Info]\n"
        f"Title: {clip.title}\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {play_res_x}\n"
        f"PlayResY: {play_res_y}\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Arial,{font_size},&H00FFFFFF,&H0000FFFF,&H000B0F17,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,{margin_v},1\n"
        f"Style: HookBanner,Arial,{max(36, font_size - 4)},&H00170F0B,&H00FFFFFF,&H00F8FAFC,&H00F8FAFC,-1,0,0,0,100,100,0,0,3,14,0,8,60,60,180,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    events: List[str] = []
    if include_hook_banner and clip.caption_hook:
        hook_end = min(3.5, clip.duration_sec)
        safe_hook = clip.caption_hook.replace("\n", " ").replace("{", "(").replace("}", ")")
        events.append(
            f"Dialogue: 1,0:00:00.00,{format_ass_timestamp(hook_end)},HookBanner,,0,0,0,,{safe_hook}"
        )

    phrases = _group_words_into_phrases(
        transcript.all_words(),
        clip.start_sec,
        clip.end_sec,
        max_words_per_line=4 if aspect_ratio == AspectRatio.VERTICAL_9_16 else 7,
    )
    for s, e, text in phrases:
        safe_text = text.replace("{", "(").replace("}", ")")
        events.append(
            f"Dialogue: 0,{format_ass_timestamp(s)},{format_ass_timestamp(e)},Default,,0,0,0,,{safe_text}"
        )

    return header + "\n".join(events) + "\n"
