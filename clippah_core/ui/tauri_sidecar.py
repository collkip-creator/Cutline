"""
Tauri v2 Local Sidecar Server (FastAPI).

For Tauri v2 Windows/macOS/Linux packaging, bundle this module with PyInstaller
as `cutline-sidecar-<target-triple>` declared in `src-tauri/tauri.conf.json`.
The React frontend communicates over http://127.0.0.1:43111 with zero cloud calls.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..adapters.desktop_ffmpeg import FFmpegVideoProcessor, resolve_media_binary
from ..adapters.desktop_ollama import OllamaHighlightEngine
from ..adapters.desktop_whisper import FasterWhisperTranscriber
from ..adapters.desktop_ytdlp import DesktopMediaDownloader
from ..adapters.social_adapters import build_default_publishers
from ..core.cache import TranscriptCache, compute_file_sha256
from ..core.captions import generate_ass, generate_srt
from ..core.grounding import ground_and_deduplicate_clips, snap_clip_to_words
from ..core.pipeline import ClippahPipeline
from ..core.queue import PublishQueueStore
from ..core.schemas import (
    AspectRatio,
    ClipCandidate,
    EncodeMode,
    ExportSpec,
    PublishPlatform,
    PublishStatus,
    Transcript,
    TranscriptSegment,
    WordTimestamp,
)

DATA_ROOT = Path.home() / ".cutline_studio"
VIDEOS_DIR = DATA_ROOT / "videos"
EXPORTS_DIR = DATA_ROOT / "exports"
CACHE_DIR = DATA_ROOT / "transcript_cache"
PROJECTS_INDEX = DATA_ROOT / "projects.json"

for d in (DATA_ROOT, VIDEOS_DIR, EXPORTS_DIR, CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)

video_processor = FFmpegVideoProcessor()
cache_store = TranscriptCache(CACHE_DIR)
pipeline = ClippahPipeline(
    downloader=DesktopMediaDownloader(video_processor),
    transcriber=FasterWhisperTranscriber(model_size="small", compute_type="int8"),
    highlight_engine=OllamaHighlightEngine(),
    video_processor=video_processor,
    cache=cache_store,
    workspace_dir=VIDEOS_DIR,
)
queue_store = PublishQueueStore(DATA_ROOT / "clippah_queue.db")
publishers = build_default_publishers()

app = FastAPI(title="Cutline Studio Local Sidecar", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")
app.mount("/media/exports", StaticFiles(directory=str(EXPORTS_DIR)), name="exports")


def _read_projects() -> List[Dict[str, Any]]:
    if not PROJECTS_INDEX.exists():
        return []
    try:
        return json.loads(PROJECTS_INDEX.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write_projects(items: List[Dict[str, Any]]) -> None:
    PROJECTS_INDEX.write_text(json.dumps(items, indent=2), encoding="utf-8")


def _upsert_project(record: Dict[str, Any]) -> None:
    items = _read_projects()
    idx = next((i for i, p in enumerate(items) if p["video_hash"] == record["video_hash"]), -1)
    if idx >= 0:
        items[idx] = record
    else:
        items.insert(0, record)
    _write_projects(items)


class UrlRequest(BaseModel):
    url: str


class HighlightsRequest(BaseModel):
    prompt: str = "High-retention hooks, bold insights, concise takeaways"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:14b"
    min_clip_sec: float = 8.0
    max_clip_sec: float = 45.0
    max_clips: int = 6


class SnapRequest(BaseModel):
    clip: ClipCandidate
    transcript: Transcript


class CaptionsRequest(BaseModel):
    clip: ClipCandidate
    transcript: Transcript
    aspect_ratio: AspectRatio = AspectRatio.VERTICAL_9_16


class ExportRequest(BaseModel):
    video_hash: str
    clip: ClipCandidate
    aspect_ratio: AspectRatio = AspectRatio.VERTICAL_9_16
    encode_mode: EncodeMode = EncodeMode.REENCODE
    include_srt: bool = True
    burn_captions: bool = True


class QueueRequest(BaseModel):
    clip_id: str
    clip_title: str
    video_path: str
    srt_path: Optional[str] = None
    platform: PublishPlatform
    caption_text: str
    tags: List[str] = []
    scheduled_at_iso: Optional[str] = None


@app.get("/api/health")
def health():
    ffmpeg_bin = resolve_media_binary("ffmpeg")
    ytdlp_bin = resolve_media_binary("yt-dlp")
    return {
        "status": "ok",
        "mode": "tauri-sidecar",
        "ffmpeg": Path(ffmpeg_bin).is_file() or shutil.which(ffmpeg_bin) is not None,
        "ytdlp": Path(ytdlp_bin).is_file() or shutil.which(ytdlp_bin) is not None,
    }


@app.get("/api/projects")
def list_projects():
    projects = _read_projects()
    for p in projects:
        p["transcript_cached"] = cache_store.get(p["video_hash"]) is not None
    return projects


@app.get("/api/projects/{video_hash}")
def get_project(video_hash: str):
    proj = next((p for p in _read_projects() if p["video_hash"] == video_hash), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    tr = cache_store.get(video_hash)
    return {
        "project": proj,
        "transcript": tr.model_dump() if tr else None,
        "cache_hit": tr is not None,
    }


@app.post("/api/projects/sample")
def create_sample():
    sample_name = "cutline_architecture_briefing.mp4"
    target = VIDEOS_DIR / sample_name
    if not target.exists():
        ffmpeg_bin = resolve_media_binary("ffmpeg")
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
                "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=30",
                "-af", "volume=0.08",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                target.as_posix(),
            ],
            check=True,
        )
    meta = video_processor.probe_media(target)
    vhash = compute_file_sha256(target)
    tr = cache_store.get(vhash)
    if tr is None:
        lines = [
            "Why do cloud AI video editors stall the moment your studio bandwidth drops?",
            "Keeping transcription local with faster-whisper eliminates latency and protects privacy.",
            "Content-addressed transcript caching means re-running prompts takes zero milliseconds.",
            "Every LLM timestamp gets snapped to exact word boundaries before FFmpeg cuts the clip.",
        ]
        dur = float(meta["duration_sec"] or 30.0)
        step = dur / len(lines)
        segs = []
        for idx, line in enumerate(lines):
            s0 = round(idx * step + 0.15, 3)
            s1 = round((idx + 1) * step - 0.12, 3)
            toks = line.split()
            wstep = (s1 - s0) / max(1, len(toks))
            words = [
                WordTimestamp(
                    word=t,
                    start_sec=round(s0 + wi * wstep, 3),
                    end_sec=round(s0 + (wi + 0.88) * wstep, 3),
                )
                for wi, t in enumerate(toks)
            ]
            segs.append(TranscriptSegment(id=idx, start_sec=s0, end_sec=s1, text=line, words=words))
        tr = Transcript(video_hash=vhash, source_path=str(target), duration_sec=dur, segments=segs)
        cache_store.put(tr)

    clips = pipeline.find_clips(tr, "High-retention hooks and local architecture", min_clip_sec=6.0)
    record = {
        "video_hash": vhash,
        "title": "Cutline Local-First Architecture Briefing",
        "filename": sample_name,
        "local_path": str(target),
        "video_url": f"/media/videos/{sample_name}",
        "source_url": None,
        **meta,
        "created_at_iso": datetime.now(timezone.utc).isoformat(),
        "clips": [c.model_dump() for c in clips],
    }
    _upsert_project(record)
    return {"project": record, "transcript": tr.model_dump(), "cache_hit": True}


@app.post("/api/projects/upload")
async def upload_video(video: UploadFile = File(...)):
    safe_name = f"{int(datetime.now().timestamp())}_{Path(video.filename or 'clip.mp4').name}"
    dest = VIDEOS_DIR / safe_name
    with dest.open("wb") as fh:
        shutil.copyfileobj(video.file, fh)
    meta = video_processor.probe_media(dest)
    vhash = compute_file_sha256(dest)
    tr = cache_store.get(vhash)
    record = {
        "video_hash": vhash,
        "title": dest.stem,
        "filename": safe_name,
        "local_path": str(dest),
        "video_url": f"/media/videos/{safe_name}",
        "source_url": None,
        **meta,
        "created_at_iso": datetime.now(timezone.utc).isoformat(),
        "clips": [],
    }
    _upsert_project(record)
    return {"project": record, "transcript": tr.model_dump() if tr else None, "cache_hit": tr is not None}


@app.post("/api/projects/url")
def ingest_url(req: UrlRequest):
    asset = pipeline.downloader.ingest(req.url, VIDEOS_DIR)
    tr = cache_store.get(asset.video_hash)
    fname = Path(asset.local_path).name
    record = {
        "video_hash": asset.video_hash,
        "title": asset.title,
        "filename": fname,
        "local_path": asset.local_path,
        "video_url": f"/media/videos/{fname}",
        "source_url": asset.source_url,
        "duration_sec": asset.duration_sec,
        "width": asset.width,
        "height": asset.height,
        "fps": asset.fps,
        "has_audio": asset.has_audio,
        "created_at_iso": datetime.now(timezone.utc).isoformat(),
        "clips": [],
    }
    _upsert_project(record)
    return {"project": record, "transcript": tr.model_dump() if tr else None, "cache_hit": tr is not None}


@app.post("/api/projects/{video_hash}/transcribe")
def transcribe_project(video_hash: str, body: Optional[Dict[str, Any]] = None):
    proj = next((p for p in _read_projects() if p["video_hash"] == video_hash), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    force = bool((body or {}).get("force", False))
    if not force:
        cached = cache_store.get(video_hash)
        if cached:
            return {"transcript": cached.model_dump(), "cache_hit": True}
    wav_path = CACHE_DIR / f"{video_hash[:12]}_16k.wav"
    video_processor.extract_audio(Path(proj["local_path"]), wav_path)
    tr = pipeline.transcriber.transcribe(wav_path, video_hash=video_hash)
    cache_store.put(tr, pipeline.transcriber.model_identifier)
    return {"transcript": tr.model_dump(), "cache_hit": False}


@app.post("/api/projects/{video_hash}/highlights")
def extract_highlights(video_hash: str, req: HighlightsRequest):
    proj = next((p for p in _read_projects() if p["video_hash"] == video_hash), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    tr = cache_store.get(video_hash)
    if not tr:
        raise HTTPException(status_code=400, detail="Transcribe video first")
    pipeline.highlight_engine = OllamaHighlightEngine(base_url=req.ollama_url, model=req.ollama_model)
    clips = pipeline.find_clips(
        tr, req.prompt, min_clip_sec=req.min_clip_sec, max_clip_sec=req.max_clip_sec, max_clips=req.max_clips
    )
    proj["clips"] = [c.model_dump() for c in clips]
    _upsert_project(proj)
    return {"clips": proj["clips"]}


@app.put("/api/projects/{video_hash}/clips")
def save_clips(video_hash: str, body: Dict[str, Any]):
    proj = next((p for p in _read_projects() if p["video_hash"] == video_hash), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    proj["clips"] = body.get("clips", [])
    _upsert_project(proj)
    return {"clips": proj["clips"]}


@app.post("/api/clips/snap")
def snap_clip(req: SnapRequest):
    return snap_clip_to_words(req.clip, req.transcript).model_dump()


@app.post("/api/clips/captions")
def preview_captions(req: CaptionsRequest):
    return {
        "srt": generate_srt(req.clip, req.transcript),
        "ass": generate_ass(req.clip, req.transcript, aspect_ratio=req.aspect_ratio),
    }


@app.post("/api/clips/export")
def export_clip(req: ExportRequest):
    proj = next((p for p in _read_projects() if p["video_hash"] == req.video_hash), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    tr = cache_store.get(req.video_hash)
    if not tr:
        raise HTTPException(status_code=400, detail="Transcript missing")
    spec = ExportSpec(
        clip=req.clip,
        aspect_ratio=req.aspect_ratio,
        encode_mode=req.encode_mode,
        include_srt=req.include_srt,
        burn_captions=req.burn_captions,
        output_dir=str(EXPORTS_DIR),
    )
    srt_text = generate_srt(req.clip, tr) if req.include_srt else None
    ass_text = generate_ass(req.clip, tr, aspect_ratio=req.aspect_ratio) if req.burn_captions else None
    result = video_processor.render_clip(Path(proj["local_path"]), spec, srt_content=srt_text, ass_content=ass_text)
    payload = result.model_dump()
    payload["video_url"] = f"/media/exports/{Path(result.video_path).name}"
    payload["srt_url"] = f"/media/exports/{Path(result.srt_path).name}" if result.srt_path else None
    payload["ass_url"] = f"/media/exports/{Path(result.ass_path).name}" if result.ass_path else None
    return payload


@app.get("/api/queue")
def list_queue():
    return [j.model_dump() for j in queue_store.list_jobs()]


@app.post("/api/queue")
def enqueue_job(req: QueueRequest):
    return queue_store.enqueue(**req.model_dump()).model_dump()


@app.post("/api/queue/process")
def process_due(body: Optional[Dict[str, Any]] = None):
    include_future = bool((body or {}).get("include_future", False))
    processed = queue_store.process_due_jobs(publishers, include_future_scheduled=include_future)
    return [j.model_dump() for j in processed]


@app.post("/api/queue/{job_id}/retry")
def retry_job(job_id: str):
    updated = queue_store.update_status(job_id, PublishStatus.QUEUED, error_message=None)
    return updated.model_dump() if updated else {}


@app.delete("/api/queue/{job_id}")
def delete_job(job_id: str):
    return {"deleted": queue_store.delete_job(job_id)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=43111)
