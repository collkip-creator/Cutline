"""
Desktop MediaDownloader adapter using local files or yt-dlp for streaming URLs.

Android adaptation note: Replace subprocess yt-dlp invocation with a pure-Python
yt-dlp library import via Chaquopy (for URL extraction) + Android DownloadManager
or SAF (Storage Access Framework) ContentResolver URI streaming for local files.
"""

from __future__ import annotations

from pathlib import Path
import json
import shutil
import subprocess
from typing import Optional
from urllib.parse import urlparse

from ..core.cache import compute_file_sha256
from ..core.interfaces import MediaDownloader, ProgressCallback, VideoProcessor
from ..core.schemas import MediaAsset
from .desktop_ffmpeg import _subprocess_kwargs, resolve_media_binary


class DesktopMediaDownloader(MediaDownloader):
    def __init__(self, video_processor: VideoProcessor, ytdlp_bin: Optional[str] = None) -> None:
        self.video_processor = video_processor
        self.ytdlp_bin = ytdlp_bin or resolve_media_binary("yt-dlp")

    def ingest(
        self,
        source: str,
        workspace_dir: Path,
        on_progress: ProgressCallback = None,
    ) -> MediaAsset:
        workspace_dir = Path(workspace_dir)
        workspace_dir.mkdir(parents=True, exist_ok=True)

        parsed = urlparse(source)
        is_url = parsed.scheme in ("http", "https")

        if not is_url:
            local_path = Path(source).expanduser().resolve()
            if not local_path.exists():
                raise FileNotFoundError(f"Local media file not found: {local_path}")
            title = local_path.stem
            source_url = None
        else:
            if not Path(self.ytdlp_bin).is_file() and shutil.which(self.ytdlp_bin) is None:
                raise RuntimeError(
                    f"'{self.ytdlp_bin}' binary not found on PATH or bundled bin/. Install yt-dlp or import a local MP4."
                )
            if on_progress:
                on_progress(0.10, "Downloading stream via yt-dlp...")

            out_template = str(workspace_dir / "%(id)s.%(ext)s")
            cmd = [
                self.ytdlp_bin,
                "--no-playlist",
                "-f",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                "--merge-output-format",
                "mp4",
                "--print-json",
                "-o",
                out_template,
                source,
            ]
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
                **_subprocess_kwargs(),
            )
            if proc.returncode != 0:
                raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip() or proc.stdout.strip()}")

            info = json.loads(proc.stdout.strip().splitlines()[-1])
            local_path = Path(info.get("_filename") or info.get("requested_downloads", [{}])[0].get("filepath"))
            title = info.get("title") or local_path.stem
            source_url = source

        meta = self.video_processor.probe_media(local_path)
        video_hash = compute_file_sha256(local_path)

        return MediaAsset(
            video_hash=video_hash,
            title=title,
            local_path=str(local_path),
            source_url=source_url,
            duration_sec=float(meta.get("duration_sec", 0.0)),
            width=int(meta.get("width", 1280)),
            height=int(meta.get("height", 720)),
            fps=float(meta.get("fps", 30.0)),
            has_audio=bool(meta.get("has_audio", True)),
        )
