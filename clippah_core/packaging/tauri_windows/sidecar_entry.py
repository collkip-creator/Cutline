"""Top-level PyInstaller entrypoint using absolute package imports for Tauri sidecar."""

from datetime import datetime, timezone
import multiprocessing
from pathlib import Path
import sys
import traceback


def _setup_stdio_log() -> Path:
    log_dir = Path.home() / ".cutline_studio"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "sidecar.log"
    log_file = log_path.open("a", encoding="utf-8", buffering=1)
    # PyInstaller with console=False sets sys.stdout/sys.stderr to None on Windows,
    # which crashes uvicorn logging and tqdm progress bars unless redirected.
    if sys.stdout is None:
        sys.stdout = log_file
    if sys.stderr is None:
        sys.stderr = log_file
    return log_path


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[sidecar {ts}] {msg}", flush=True)


def _run_transcribe_worker(wav_path: str, video_hash: str, out_json: str) -> int:
    from clippah_core.adapters.desktop_whisper import FasterWhisperTranscriber

    transcriber = FasterWhisperTranscriber(model_size="base", device="cpu", compute_type="int8")
    transcript = transcriber.transcribe(Path(wav_path), video_hash=video_hash)
    Path(out_json).write_text(transcript.model_dump_json(), encoding="utf-8")
    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _setup_stdio_log()

    if len(sys.argv) >= 5 and sys.argv[1] == "--transcribe-worker":
        try:
            _log(f"Starting transcribe worker for {sys.argv[3]}")
            sys.exit(_run_transcribe_worker(sys.argv[2], sys.argv[3], sys.argv[4]))
        except Exception:
            traceback.print_exc()
            sys.exit(1)

    try:
        _log("Booting FastAPI sidecar...")
        import uvicorn
        from clippah_core.ui.tauri_sidecar import app

        _log("Binding Uvicorn on http://127.0.0.1:43111")
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=43111,
            loop="asyncio",
            http="h11",
            ws="none",
            log_config=None,
            access_log=False,
        )
    except Exception:
        traceback.print_exc()
        raise
