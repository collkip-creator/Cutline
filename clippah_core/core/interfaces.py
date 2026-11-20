"""
Pluggable engine interfaces (ABCs & Protocols) for desktop and Android portability.

Every platform-specific capability (downloading, ASR transcription, local LLM inference,
video/audio transcoding, and social publishing) sits behind one of these contracts.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Dict, Optional

from .schemas import (
    ClipCandidate,
    ExportResult,
    ExportSpec,
    HighlightBatch,
    MediaAsset,
    PublishJob,
    PublishPlatform,
    Transcript,
)

ProgressCallback = Optional[Callable[[float, str], None]]


class MediaDownloader(ABC):
    """Resolves either a local file path or a remote streaming URL into a MediaAsset."""

    @abstractmethod
    def ingest(
        self,
        source: str,
        workspace_dir: Path,
        on_progress: ProgressCallback = None,
    ) -> MediaAsset:
        """
        Accept a local filesystem path or HTTP(S) streaming URL.
        Returns normalized MediaAsset metadata with content SHA-256 hash.
        """


class Transcriber(ABC):
    """Speech-to-text engine producing word-level timestamps and VAD segments."""

    @property
    @abstractmethod
    def model_identifier(self) -> str:
        """Identifier stored in transcript cache metadata (e.g. 'faster-whisper-small-int8')."""

    @abstractmethod
    def transcribe(
        self,
        audio_or_video_path: Path,
        video_hash: str,
        language: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ) -> Transcript:
        """Transcribe media to word-timestamped Transcript."""


class HighlightEngine(ABC):
    """Local/LAN inference engine selecting viral/high-retention clips from a Transcript."""

    @abstractmethod
    def extract_highlights(
        self,
        transcript: Transcript,
        user_prompt: str,
        min_clip_sec: float = 12.0,
        max_clip_sec: float = 60.0,
        max_clips: int = 8,
    ) -> HighlightBatch:
        """Return structured HighlightBatch grounded in the supplied transcript."""


class VideoProcessor(ABC):
    """Media cutting, aspect-ratio reframing, audio extraction, and subtitle burning."""

    @abstractmethod
    def probe_media(self, media_path: Path) -> Dict[str, float | int | bool]:
        """Return duration_sec, width, height, fps, and has_audio."""

    @abstractmethod
    def extract_audio(self, video_path: Path, output_wav_path: Path) -> Path:
        """Extract 16kHz mono PCM WAV for ASR backends."""

    @abstractmethod
    def render_clip(
        self,
        source_video: Path,
        spec: ExportSpec,
        srt_content: Optional[str] = None,
        ass_content: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ) -> ExportResult:
        """Cut and optionally reframe/burn captions for a single ClipCandidate."""


class SocialPublisher(ABC):
    """Adapter for publishing exported clips to a target social platform."""

    @property
    @abstractmethod
    def platform(self) -> PublishPlatform:
        """Platform handled by this adapter."""

    @abstractmethod
    def publish(self, job: PublishJob) -> str:
        """
        Publish the clip described by `job` and return the canonical post URL or remote ID.
        Raises RuntimeError on transient or permanent platform failures.
        """
