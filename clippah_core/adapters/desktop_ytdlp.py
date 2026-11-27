"""
Desktop MediaDownloader adapter using local files or yt-dlp for streaming URLs.

Optimizes YouTube/streaming downloads via multi-connection fragment fetching (-N 8),
aria2c acceleration when available, smart resolution caps (720p/1080p), and
concurrent audio-only MP3 extraction + transcription while the video downloads.

Android adaptation note: Replace subprocess yt-dlp invocation with a pure-Python
yt-dlp library import via Chaquopy (for URL extraction) + Android DownloadManager
or SAF (Storage Access Framework) ContentResolver URI streaming for local files.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import shutil
import subprocess
import time
from typing import Any, Callable, Optional, Tuple
from urllib.parse import urlparse

from ..core.cache import compute_file_sha256
from ..core.interfaces import MediaDownloader, ProgressCallback, VideoProcessor
from ..core.schemas import MediaAsset
from .desktop_ffmpeg import _subprocess_kwargs, resolve_media_binary


def resolve_ytdlp_command(ytdlp_bin: Optional[str] = None) -> list[str]:
    candidate = ytdlp_bin or resolve_media_binary("yt-dlp")
    if Path(candidate).is_file() or shutil.which(candidate) is not None:
        return [candidate]
    try:
        import yt_dlp  # type: ignore  # noqa: F401
        import sys

        return [sys.executable, "-m", "yt_dlp"]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"'{candidate}' binary not found on PATH or bundled bin/. Install yt-dlp or import a local MP4."
        ) from exc


def build_ytdlp_format_selector(quality: str = "hd") -> str:
    if quality == "fast":
        return "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b"
    return "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b"


def build_ytdlp_fast_flags(ffmpeg_bin: Optional[str] = None) -> list[str]:
    flags = [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--concurrent-fragments",
        "8",
        "--socket-timeout",
        "15",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
    ]
    if shutil.which("aria2c") is not None:
        flags.extend(["--downloader", "aria2c", "--downloader-args", "aria2c:-x 8 -s 8 -k 1M"])
    if ffmpeg_bin and Path(ffmpeg_bin).is_file():
        flags.extend(["--ffmpeg-location", str(Path(ffmpeg_bin).parent)])
    return flags


def extract_mp3_audio(
    source_path: Path,
    output_mp3_path: Path,
    ffmpeg_bin: Optional[str] = None,
) -> Path:
    ffmpeg = ffmpeg_bin or resolve_media_binary("ffmpeg")
    output_mp3_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "48k",
            str(output_mp3_path),
        ],
        capture_output=True,
        text=True,
        check=False,
        **_subprocess_kwargs(),
    )
    if proc.returncode != 0 or not output_mp3_path.is_file():
        raise RuntimeError(
            f"FFmpeg MP3 extraction failed: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return output_mp3_path


class DesktopMediaDownloader(MediaDownloader):
    def __init__(self, video_processor: VideoProcessor, ytdlp_bin: Optional[str] = None) -> None:
        self.video_processor = video_processor
        self.ytdlp_bin = ytdlp_bin or resolve_media_binary("yt-dlp")

    def _download_video_only(
        self,
        source: str,
        workspace_dir: Path,
        quality: str = "hd",
    ) -> Tuple[Path, str]:
        ytdlp_cmd = resolve_ytdlp_command(self.ytdlp_bin)
        ffmpeg_bin = getattr(self.video_processor, "ffmpeg_bin", None) or resolve_media_binary("ffmpeg")
        out_template = str(workspace_dir / "%(id)s.%(ext)s")
        cmd = [
            *ytdlp_cmd,
            *build_ytdlp_fast_flags(ffmpeg_bin),
            "-f",
            build_ytdlp_format_selector(quality),
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
        title = str(info.get("title") or local_path.stem)
        return local_path, title

    def _download_and_extract_mp3(
        self,
        source: str,
        temp_audio_dir: Path,
    ) -> Optional[Path]:
        ytdlp_cmd = resolve_ytdlp_command(self.ytdlp_bin)
        ffmpeg_bin = getattr(self.video_processor, "ffmpeg_bin", None) or resolve_media_binary("ffmpeg")
        temp_audio_dir.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time() * 1000)
        raw_tpl = str(temp_audio_dir / f".tmp_aud_{stamp}.%(ext)s")
        cmd = [
            *ytdlp_cmd,
            *build_ytdlp_fast_flags(ffmpeg_bin),
            "-f",
            "ba[ext=m4a]/ba",
            "--print-json",
            "-o",
            raw_tpl,
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
            return None
        json_lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip().startswith("{")]
        if not json_lines:
            return None
        info = json.loads(json_lines[-1])
        raw_path_str = (info.get("requested_downloads") or [{}])[0].get("filepath") or info.get("_filename")
        if not raw_path_str:
            return None
        raw_path = Path(raw_path_str)
        if not raw_path.is_file():
            return None
        mp3_out = temp_audio_dir / f".tmp_aud_{stamp}.mp3"
        try:
            extract_mp3_audio(raw_path, mp3_out, ffmpeg_bin=ffmpeg_bin)
            return mp3_out
        finally:
            if raw_path != mp3_out and raw_path.is_file():
                try:
                    raw_path.unlink()
                except Exception:  # noqa: BLE001
                    pass

    def ingest_with_parallel_audio(
        self,
        source: str,
        workspace_dir: Path,
        audio_dir: Path,
        quality: str = "hd",
        transcribe_mp3_fn: Optional[Callable[[Path], Any]] = None,
        on_stage: Optional[Callable[[str, str], None]] = None,
    ) -> Tuple[MediaAsset, Optional[Path], Any]:
        workspace_dir = Path(workspace_dir)
        audio_dir = Path(audio_dir)
        workspace_dir.mkdir(parents=True, exist_ok=True)
        audio_dir.mkdir(parents=True, exist_ok=True)

        ffmpeg_bin = getattr(self.video_processor, "ffmpeg_bin", None) or resolve_media_binary("ffmpeg")
        parsed = urlparse(source)
        if parsed.scheme not in ("http", "https"):
            local_path = Path(source).expanduser().resolve()
            if not local_path.exists():
                raise FileNotFoundError(f"Local media file not found: {local_path}")
            meta = self.video_processor.probe_media(local_path)
            video_hash = compute_file_sha256(local_path)
            mp3_path = audio_dir / f"{video_hash[:16]}.mp3"
            transcript_obj = None
            if bool(meta.get("has_audio", True)):
                if on_stage:
                    on_stage("audio_mp3", "Extracting MP3 audio track...")
                extract_mp3_audio(local_path, mp3_path, ffmpeg_bin=ffmpeg_bin)
                if transcribe_mp3_fn:
                    if on_stage:
                        on_stage("transcribing", "Generating timed transcript from MP3...")
                    transcript_obj = transcribe_mp3_fn(mp3_path)
            asset = MediaAsset(
                video_hash=video_hash,
                title=local_path.stem,
                local_path=str(local_path),
                audio_path=str(mp3_path) if mp3_path.is_file() else None,
                source_url=None,
                duration_sec=float(meta.get("duration_sec", 0.0)),
                width=int(meta.get("width", 1280)),
                height=int(meta.get("height", 720)),
                fps=float(meta.get("fps", 30.0)),
                has_audio=bool(meta.get("has_audio", True)),
            )
            return asset, (mp3_path if mp3_path.is_file() else None), transcript_obj

        # Validate yt-dlp exists before launching parallel workers
        resolve_ytdlp_command(self.ytdlp_bin)
        if on_stage:
            on_stage(
                "downloading",
                "Downloading video (-N 8) and extracting MP3 + timed transcript in parallel...",
            )

        def _audio_and_transcribe_worker() -> Tuple[Optional[Path], Any]:
            mp3_tmp = self._download_and_extract_mp3(source, audio_dir)
            if not mp3_tmp or not mp3_tmp.is_file():
                return None, None
            if on_stage:
                on_stage("audio_ready", "MP3 track extracted; transcribing timestamps while video downloads...")
            tr_obj = transcribe_mp3_fn(mp3_tmp) if transcribe_mp3_fn else None
            if tr_obj is not None and on_stage:
                on_stage("transcript_ready", "Timed transcript ready before video download completed.")
            return mp3_tmp, tr_obj

        with ThreadPoolExecutor(max_workers=2) as pool:
            vid_future = pool.submit(self._download_video_only, source, workspace_dir, quality)
            aud_future = pool.submit(_audio_and_transcribe_worker)
            local_path, title = vid_future.result()
            mp3_tmp, transcript_obj = aud_future.result()

        meta = self.video_processor.probe_media(local_path)
        video_hash = compute_file_sha256(local_path)
        final_mp3 = audio_dir / f"{video_hash[:16]}.mp3"

        if mp3_tmp and mp3_tmp.is_file():
            if mp3_tmp != final_mp3:
                shutil.move(str(mp3_tmp), str(final_mp3))
        elif bool(meta.get("has_audio", True)):
            if on_stage:
                on_stage("audio_mp3", "Extracting MP3 audio track from downloaded video...")
            extract_mp3_audio(local_path, final_mp3, ffmpeg_bin=ffmpeg_bin)
            if transcribe_mp3_fn and transcript_obj is None:
                if on_stage:
                    on_stage("transcribing", "Generating timed transcript from MP3...")
                transcript_obj = transcribe_mp3_fn(final_mp3)

        asset = MediaAsset(
            video_hash=video_hash,
            title=title,
            local_path=str(local_path),
            audio_path=str(final_mp3) if final_mp3.is_file() else None,
            source_url=source,
            duration_sec=float(meta.get("duration_sec", 0.0)),
            width=int(meta.get("width", 1280)),
            height=int(meta.get("height", 720)),
            fps=float(meta.get("fps", 30.0)),
            has_audio=bool(meta.get("has_audio", True)),
        )
        return asset, (final_mp3 if final_mp3.is_file() else None), transcript_obj

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
            if on_progress:
                on_progress(0.10, "Downloading stream via multi-connection yt-dlp...")
            local_path, title = self._download_video_only(source, workspace_dir, quality="hd")
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
