"""
Desktop Transcriber adapter backed by faster-whisper (CTranslate2 + Silero VAD).

Android adaptation note: Swap this adapter for a whisper.cpp JNI bridge or
ONNX Runtime Mobile (whisper-tiny.en / whisper-base.en quantized int8) returning
the exact same `Transcript` & `WordTimestamp` schema.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from ..core.interfaces import ProgressCallback, Transcriber
from ..core.schemas import Transcript, TranscriptSegment, WordTimestamp


class FasterWhisperTranscriber(Transcriber):
    def __init__(
        self,
        model_size: str = "small",
        device: str = "auto",
        compute_type: str = "int8",
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model = None

    @property
    def model_identifier(self) -> str:
        return f"faster-whisper-{self.model_size}-{self.compute_type}"

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper is not installed. Run `pip install faster-whisper` on desktop."
            ) from exc
        self._model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
        )
        return self._model

    def transcribe(
        self,
        audio_or_video_path: Path,
        video_hash: str,
        language: Optional[str] = None,
        on_progress: ProgressCallback = None,
    ) -> Transcript:
        model = self._ensure_model()
        segments_iter, info = model.transcribe(
            str(audio_or_video_path),
            language=language,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 450},
        )

        segments: List[TranscriptSegment] = []
        total_dur = float(getattr(info, "duration", 0.0) or 0.0)

        for idx, seg in enumerate(segments_iter):
            words = [
                WordTimestamp(
                    word=w.word.strip(),
                    start_sec=round(float(w.start), 3),
                    end_sec=round(float(w.end), 3),
                    confidence=round(float(getattr(w, "probability", 0.9)), 3),
                )
                for w in (seg.words or [])
                if w.word and w.word.strip()
            ]
            segments.append(
                TranscriptSegment(
                    id=idx,
                    start_sec=round(float(seg.start), 3),
                    end_sec=round(float(seg.end), 3),
                    text=seg.text.strip(),
                    words=words,
                )
            )
            if on_progress and total_dur > 0:
                pct = min(0.95, 0.45 + 0.50 * (float(seg.end) / total_dur))
                on_progress(pct, f"Transcribed {seg.end:.1f}s / {total_dur:.1f}s")

        return Transcript(
            video_hash=video_hash,
            source_path=str(audio_or_video_path),
            language=getattr(info, "language", None) or language or "en",
            duration_sec=total_dur or (segments[-1].end_sec if segments else 0.0),
            model_name=self.model_identifier,
            segments=segments,
        )
