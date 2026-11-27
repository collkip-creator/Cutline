"""
Pure domain schemas for Cutline / Clippah.

Uses Pydantic v2 when installed; includes a zero-dependency stdlib fallback shim
so pure domain logic & unit tests execute cleanly even in minimal Python runtimes
(such as restricted build sandboxes or lightweight mobile Python embeds).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from enum import Enum
from typing import Any, List, Literal, Optional, Type, TypeVar
import json

try:
    from pydantic import BaseModel, ConfigDict, Field, model_validator

    PYDANTIC_AVAILABLE = True
except ImportError:  # pragma: no cover - stdlib fallback for minimal environments
    PYDANTIC_AVAILABLE = False

    T = TypeVar("T", bound="BaseModel")

    def Field(default: Any = ..., *, default_factory: Any = None, **_: Any) -> Any:
        if default_factory is not None:
            return field(default_factory=default_factory)
        if default is ...:
            return field()
        return field(default=default)

    def model_validator(*, mode: str = "after"):
        def decorator(fn):
            fn._is_model_validator = mode
            return fn
        return decorator

    class ConfigDict(dict):
        pass

    class BaseModel:
        def __init__(self, **data: Any) -> None:
            import typing

            try:
                hints = typing.get_type_hints(type(self))
            except Exception:
                hints = {}
                for cls in reversed(type(self).__mro__):
                    hints.update(getattr(cls, "__annotations__", {}))

            def _coerce(value: Any, hint: Any) -> Any:
                if value is None or hint is None:
                    return value
                origin = typing.get_origin(hint)
                args = typing.get_args(hint)
                if origin is typing.Union:
                    non_none = [a for a in args if a is not type(None)]
                    if len(non_none) == 1:
                        return _coerce(value, non_none[0])
                if origin in (list, List) and args and isinstance(value, list):
                    return [_coerce(item, args[0]) for item in value]
                if isinstance(hint, type) and issubclass(hint, BaseModel) and isinstance(value, dict):
                    return hint(**value)
                if isinstance(hint, type) and issubclass(hint, Enum) and not isinstance(value, hint):
                    return hint(value)
                return value

            for name, hint in hints.items():
                if name in data:
                    val = _coerce(data[name], hint)
                elif hasattr(type(self), name):
                    attr = getattr(type(self), name)
                    if hasattr(attr, "default_factory") and attr.default_factory is not None:  # type: ignore
                        val = attr.default_factory()  # type: ignore
                    else:
                        val = attr
                else:
                    raise ValueError(f"Missing required field: {name}")
                setattr(self, name, val)
            for name in dir(type(self)):
                fn = getattr(type(self), name)
                if getattr(fn, "_is_model_validator", None) == "after":
                    fn(self)

        def model_dump(self) -> dict[str, Any]:
            def _convert(obj: Any) -> Any:
                if isinstance(obj, BaseModel):
                    return obj.model_dump()
                if isinstance(obj, list):
                    return [_convert(x) for x in obj]
                if isinstance(obj, Enum):
                    return obj.value
                return obj

            annotations = {}
            for cls in reversed(type(self).__mro__):
                annotations.update(getattr(cls, "__annotations__", {}))
            return {k: _convert(getattr(self, k)) for k in annotations}

        def model_dump_json(self, indent: Optional[int] = None) -> str:
            return json.dumps(self.model_dump(), indent=indent)

        @classmethod
        def model_validate(cls: Type[T], obj: Any) -> T:
            if isinstance(obj, cls):
                return obj
            if not isinstance(obj, dict):
                raise TypeError(f"Expected dict or {cls.__name__}, got {type(obj).__name__}")
            return cls(**obj)

        @classmethod
        def model_validate_json(cls: Type[T], raw: str | bytes) -> T:
            return cls(**json.loads(raw))

        @classmethod
        def model_json_schema(cls) -> dict[str, Any]:
            annotations = {}
            for base in reversed(cls.__mro__):
                annotations.update(getattr(base, "__annotations__", {}))
            return {
                "title": cls.__name__,
                "type": "object",
                "properties": {k: {"type": "string"} for k in annotations},
            }


class AspectRatio(str, Enum):
    LANDSCAPE_16_9 = "16:9"
    VERTICAL_9_16 = "9:16"


class EncodeMode(str, Enum):
    STREAM_COPY = "stream_copy"
    REENCODE = "reencode"


class PublishPlatform(str, Enum):
    YOUTUBE_SHORTS = "youtube_shorts"
    TIKTOK = "tiktok"
    INSTAGRAM_REELS = "instagram_reels"
    X_VIDEO = "x_video"


class PublishStatus(str, Enum):
    QUEUED = "queued"
    SCHEDULED = "scheduled"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ClipCategory(str, Enum):
    LESSON = "lesson"
    ENTERTAINMENT = "entertainment"
    INSIGHT = "insight"
    HOOK = "hook"


class SubtitlePreset(str, Enum):
    CLASSIC = "classic"
    BOLD_BOX = "bold_box"
    YELLOW_POP = "yellow_pop"
    MINIMAL = "minimal"


class SubtitlePosition(str, Enum):
    BOTTOM = "bottom"
    MIDDLE = "middle"
    TOP = "top"


class SubtitleCue(BaseModel):
    id: str = "cue_1"
    start_sec: float = 0.0
    end_sec: float = 2.0
    text: str = ""

    @model_validator(mode="after")
    def _validate_cue(self) -> "SubtitleCue":
        if self.start_sec < 0:
            self.start_sec = 0.0
        if self.end_sec <= self.start_sec:
            self.end_sec = round(self.start_sec + 0.5, 3)
        return self


class SubtitleConfig(BaseModel):
    enabled: bool = True
    preset: SubtitlePreset = SubtitlePreset.CLASSIC
    position: SubtitlePosition = SubtitlePosition.BOTTOM
    font_size: int = 44
    show_hook_banner: bool = True
    custom_cues: List[SubtitleCue] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_config(self) -> "SubtitleConfig":
        try:
            fs = int(self.font_size)
        except (TypeError, ValueError):
            fs = 44
        self.font_size = max(24, min(72, fs))
        return self


class FocusMode(str, Enum):
    SMART_AUTO = "smart_auto"
    CENTER = "center"
    MANUAL = "manual"


class FocusKeyframe(BaseModel):
    time_sec: float = 0.0
    x_norm: float = 0.5
    y_norm: float = 0.45
    confidence: float = 0.8
    label: Optional[str] = None

    @model_validator(mode="after")
    def _validate_kf(self) -> "FocusKeyframe":
        self.time_sec = max(0.0, round(float(self.time_sec), 3))
        self.x_norm = max(0.0, min(1.0, round(float(self.x_norm), 4)))
        self.y_norm = max(0.0, min(1.0, round(float(self.y_norm), 4)))
        self.confidence = max(0.0, min(1.0, round(float(self.confidence), 3)))
        return self


class FocusConfig(BaseModel):
    mode: FocusMode = FocusMode.SMART_AUTO
    target_x: float = 0.5
    smoothing: float = 0.75
    keyframes: List[FocusKeyframe] = Field(default_factory=list)
    source: Optional[str] = None

    @model_validator(mode="after")
    def _validate_focus(self) -> "FocusConfig":
        self.target_x = max(0.0, min(1.0, round(float(self.target_x), 4)))
        self.smoothing = max(0.0, min(1.0, round(float(self.smoothing), 3)))
        return self


class WordTimestamp(BaseModel):
    word: str
    start_sec: float
    end_sec: float
    confidence: float = 0.95

    @model_validator(mode="after")
    def _validate_bounds(self) -> "WordTimestamp":
        if self.start_sec < 0:
            self.start_sec = 0.0
        if self.end_sec < self.start_sec:
            self.end_sec = self.start_sec
        return self


class TranscriptSegment(BaseModel):
    id: int
    start_sec: float
    end_sec: float
    text: str
    words: List[WordTimestamp] = Field(default_factory=list)


class Transcript(BaseModel):
    video_hash: str
    source_path: str
    language: str = "en"
    duration_sec: float
    model_name: str = "faster-whisper-small"
    created_at_iso: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    segments: List[TranscriptSegment] = Field(default_factory=list)

    def all_words(self) -> List[WordTimestamp]:
        out: List[WordTimestamp] = []
        for seg in self.segments:
            if seg.words:
                out.extend(seg.words)
            else:
                tokens = seg.text.split()
                if tokens:
                    step = max(0.05, (seg.end_sec - seg.start_sec) / len(tokens))
                    for idx, tok in enumerate(tokens):
                        w_start = round(seg.start_sec + idx * step, 3)
                        w_end = round(min(seg.end_sec, w_start + step), 3)
                        out.append(WordTimestamp(word=tok, start_sec=w_start, end_sec=w_end))
        return out


class MediaAsset(BaseModel):
    video_hash: str
    title: str
    local_path: str
    audio_path: Optional[str] = None
    source_url: Optional[str] = None
    duration_sec: float
    width: int = 1280
    height: int = 720
    fps: float = 30.0
    has_audio: bool = True


def _normalize_ten_point_score(raw: Any, default: float = 5.0) -> float:
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return default
    if val > 10.0:
        val = val / 10.0
    return round(max(1.0, min(10.0, val)), 1)


def _normalize_category(raw: Any) -> ClipCategory:
    if isinstance(raw, ClipCategory):
        return raw
    txt = str(raw or "").strip().lower()
    mapping = {
        "lesson": ClipCategory.LESSON,
        "lessons": ClipCategory.LESSON,
        "takeaway": ClipCategory.LESSON,
        "entertainment": ClipCategory.ENTERTAINMENT,
        "funny": ClipCategory.ENTERTAINMENT,
        "comedy": ClipCategory.ENTERTAINMENT,
        "story": ClipCategory.ENTERTAINMENT,
        "hook": ClipCategory.HOOK,
        "hooks": ClipCategory.HOOK,
        "insight": ClipCategory.INSIGHT,
        "insights": ClipCategory.INSIGHT,
    }
    return mapping.get(txt, ClipCategory.INSIGHT)


class ClipCandidate(BaseModel):
    id: str
    title: str
    category: ClipCategory = ClipCategory.INSIGHT
    sentiment: Optional[str] = None
    start_sec: float
    end_sec: float
    hook_score: float
    lesson_score: float = 5.0
    entertainment_score: float = 5.0
    reason: str
    caption_hook: str
    tags: List[str] = Field(default_factory=list)
    snapped_to_words: bool = False
    subtitles: Optional[SubtitleConfig] = None
    focus: Optional[FocusConfig] = None

    @model_validator(mode="after")
    def _validate_clip(self) -> "ClipCandidate":
        if self.start_sec < 0:
            self.start_sec = 0.0
        if self.end_sec <= self.start_sec:
            self.end_sec = round(self.start_sec + 1.0, 3)
        self.category = _normalize_category(self.category)
        self.hook_score = _normalize_ten_point_score(self.hook_score, 5.0)
        self.lesson_score = _normalize_ten_point_score(self.lesson_score, 5.0)
        self.entertainment_score = _normalize_ten_point_score(self.entertainment_score, 5.0)
        return self

    @property
    def composite_score(self) -> float:
        peak = max(self.hook_score, self.lesson_score, self.entertainment_score)
        avg = (self.hook_score + self.lesson_score + self.entertainment_score) / 3.0
        return round(0.55 * peak + 0.45 * avg, 2)

    @property
    def duration_sec(self) -> float:
        return round(self.end_sec - self.start_sec, 3)


class HighlightBatch(BaseModel):
    """Strict structured output contract expected from local Ollama / HighlightEngine."""

    clips: List[ClipCandidate] = Field(default_factory=list)


class ExportSpec(BaseModel):
    clip: ClipCandidate
    aspect_ratio: AspectRatio = AspectRatio.VERTICAL_9_16
    encode_mode: EncodeMode = EncodeMode.REENCODE
    include_srt: bool = True
    burn_captions: bool = True
    caption_font_size: int = 44
    subtitle_config: Optional[SubtitleConfig] = None
    focus_config: Optional[FocusConfig] = None
    output_dir: str = "exports"


class ExportResult(BaseModel):
    clip_id: str
    video_path: str
    srt_path: Optional[str] = None
    ass_path: Optional[str] = None
    aspect_ratio: AspectRatio
    encode_mode: EncodeMode
    duration_sec: float
    file_size_bytes: int


class PublishJob(BaseModel):
    job_id: str
    clip_id: str
    clip_title: str
    video_path: str
    srt_path: Optional[str] = None
    platform: PublishPlatform
    caption_text: str
    tags: List[str] = Field(default_factory=list)
    status: PublishStatus = PublishStatus.QUEUED
    scheduled_at_iso: Optional[str] = None
    created_at_iso: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at_iso: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    published_url: Optional[str] = None
    error_message: Optional[str] = None
    attempts: int = 0
