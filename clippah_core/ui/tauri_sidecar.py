"""
Tauri v2 Local Sidecar Server (FastAPI).

For Tauri v2 desktop packaging, bundle this module with PyInstaller as a
`sidecar` binary declared in `tauri.conf.json -> bundle.externalBin`.
The React UI communicates over http://127.0.0.1:43111 with zero cloud calls.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ..adapters.desktop_ffmpeg import FFmpegVideoProcessor
from ..adapters.desktop_ollama import OllamaHighlightEngine
from ..adapters.desktop_whisper import FasterWhisperTranscriber
from ..adapters.desktop_ytdlp import DesktopMediaDownloader
from ..adapters.social_adapters import build_default_publishers
from ..core.cache import TranscriptCache
from ..core.grounding import snap_clip_to_words
from ..core.pipeline import ClippahPipeline
from ..core.queue import PublishQueueStore
from ..core.schemas import ClipCandidate, ExportSpec, PublishPlatform, Transcript


DATA_ROOT = Path.home() / ".cutline_studio"
video_processor = FFmpegVideoProcessor()
pipeline = ClippahPipeline(
    downloader=DesktopMediaDownloader(video_processor),
    transcriber=FasterWhisperTranscriber(),
    highlight_engine=OllamaHighlightEngine(),
    video_processor=video_processor,
    cache=TranscriptCache(DATA_ROOT / "transcript_cache"),
    workspace_dir=DATA_ROOT / "workspace",
)
queue_store = PublishQueueStore(DATA_ROOT / "publish_queue.db")
publishers = build_default_publishers()

app = FastAPI(title="Cutline Studio Local Sidecar", version="0.1.0")


class IngestRequest(BaseModel):
    source: str
    prompt: str = "High-retention hooks and concise insights"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:14b"


class SnapRequest(BaseModel):
    clip: ClipCandidate
    transcript: Transcript


class QueueRequest(BaseModel):
    clip_id: str
    clip_title: str
    video_path: str
    platform: PublishPlatform
    caption_text: str
    tags: List[str] = []
    scheduled_at_iso: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "ok", "mode": "local-first"}


@app.post("/pipeline/analyze")
def analyze_media(req: IngestRequest):
    pipeline.highlight_engine = OllamaHighlightEngine(
        base_url=req.ollama_url,
        model=req.ollama_model,
    )
    asset, transcript, cache_hit = pipeline.ingest_and_transcribe(req.source)
    clips = pipeline.find_clips(transcript, req.prompt)
    return {
        "asset": asset.model_dump(),
        "transcript": transcript.model_dump(),
        "clips": [c.model_dump() for c in clips],
        "cache_hit": cache_hit,
    }


@app.post("/clips/snap")
def snap_clip(req: SnapRequest):
    return snap_clip_to_words(req.clip, req.transcript).model_dump()


@app.get("/queue")
def list_queue():
    return [j.model_dump() for j in queue_store.list_jobs()]


@app.post("/queue")
def enqueue_job(req: QueueRequest):
    return queue_store.enqueue(**req.model_dump()).model_dump()


@app.post("/queue/process")
def process_due():
    processed = queue_store.process_due_jobs(publishers)
    return [j.model_dump() for j in processed]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=43111)
