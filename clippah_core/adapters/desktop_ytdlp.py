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
            ffmpeg_bin = getattr(self.video_processor, "ffmpeg_bin", None) or resolve_media_binary("ffmpeg")
            cmd = [
                self.ytdlp_bin,
                "--no-playlist",
                "--no-warnings",
                "--no-progress",
                "-f",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                "--merge-output-format",
                "mp4",
                "--print-json",
                "-o",
                out_template,
            ]
            if Path(ffmpeg_bin).is_file():
                cmd.extend(["--ffmpeg-location", str(Path(ffmpeg_bin).parent)])
            cmd.append(source)

            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
                **_subprocess_kwargs(),
            )
            if proc.returncode != 0:
                raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip() or proc.stdout.strip()}")

            json_lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip().startswith("{")]
            if not json_lines:
                raise RuntimeError("yt-dlp did not emit metadata JSON for the requested URL.")
            info = json.loads(json_lines[-1])
            dl_path = (info.get("requested_downloads") or [{}])[0].get("filepath") or info.get("_filename")
            if not dl_path:
                raise RuntimeError("yt-dlp completed without an output file path.")
            local_path = Path(dl_path)
            if not local_path.exists() and local_path.with_suffix(".mp4").exists():
                local_path = local_path.with_suffix(".mp4")
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
