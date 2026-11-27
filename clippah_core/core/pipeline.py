"""
High-level clipping pipeline orchestrator.

Composes pluggable engines cleanly with zero direct dependency on PyQt6, Tauri,
FFmpeg CLI, Whisper, or Android APIs.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

from .cache import TranscriptCache
from .captions import generate_ass, generate_srt
from .grounding import ground_and_deduplicate_clips
from .interfaces import (
    HighlightEngine,
    MediaDownloader,
    ProgressCallback,
    Transcriber,
    VideoProcessor,
)
from .schemas import ClipCandidate, ExportResult, ExportSpec, MediaAsset, Transcript


class ClippahPipeline:
    def __init__(
        self,
        *,
        downloader: MediaDownloader,
        transcriber: Transcriber,
        highlight_engine: HighlightEngine,
        video_processor: VideoProcessor,
        cache: TranscriptCache,
        workspace_dir: Path,
    ) -> None:
        self.downloader = downloader
        self.transcriber = transcriber
        self.highlight_engine = highlight_engine
        self.video_processor = video_processor
        self.cache = cache
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)

    def ingest_and_transcribe(
        self,
        source: str,
        language: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ) -> Tuple[MediaAsset, Transcript, bool]:
        if on_progress:
            on_progress(0.05, "Resolving media source...")
        asset = self.downloader.ingest(source, self.workspace_dir, on_progress=on_progress)

        cached = self.cache.get(asset.video_hash, self.transcriber.model_identifier)
        if cached is not None:
            if on_progress:
                on_progress(1.0, "Loaded cached transcript (0ms)")
            return asset, cached, True

        audio_wav = self.workspace_dir / f"{asset.video_hash[:12]}_16k.wav"
        if on_progress:
            on_progress(0.25, "Extracting 16kHz mono audio...")
        self.video_processor.extract_audio(Path(asset.local_path), audio_wav)

        if on_progress:
            on_progress(0.45, f"Transcribing with {self.transcriber.model_identifier}...")
        transcript = self.transcriber.transcribe(
            audio_wav,
            video_hash=asset.video_hash,
            language=language,
            on_progress=on_progress,
        )
        self.cache.put(transcript, self.transcriber.model_identifier)
        if on_progress:
            on_progress(1.0, "Transcription cached")
        return asset, transcript, False

    def find_clips(
        self,
        transcript: Transcript,
        user_prompt: str,
        *,
        min_clip_sec: float = 12.0,
        max_clip_sec: float = 60.0,
        max_clips: int = 8,
        title: str = "",
        video_category: Optional[str] = None,
    ) -> List[ClipCandidate]:
        try:
            raw_batch = self.highlight_engine.extract_highlights(  # type: ignore[call-arg]
                transcript,
                user_prompt=user_prompt,
                min_clip_sec=min_clip_sec,
                max_clip_sec=max_clip_sec,
                max_clips=max_clips,
                title=title,
                video_category=video_category,
            )
        except TypeError:
            raw_batch = self.highlight_engine.extract_highlights(
                transcript,
                user_prompt=user_prompt,
                min_clip_sec=min_clip_sec,
                max_clip_sec=max_clip_sec,
                max_clips=max_clips,
            )
        return ground_and_deduplicate_clips(raw_batch.clips, transcript)

    def export_clip(
        self,
        asset: MediaAsset,
        transcript: Transcript,
        spec: ExportSpec,
        on_progress: ProgressCallback = None,
    ) -> ExportResult:
        srt_text = generate_srt(spec.clip, transcript) if spec.include_srt else None
        ass_text = (
            generate_ass(
                spec.clip,
                transcript,
                aspect_ratio=spec.aspect_ratio,
                font_size=spec.caption_font_size,
            )
            if spec.burn_captions
            else None
        )
        return self.video_processor.render_clip(
            source_video=Path(asset.local_path),
            spec=spec,
            srt_content=srt_text,
            ass_content=ass_text,
            on_progress=on_progress,
        )
