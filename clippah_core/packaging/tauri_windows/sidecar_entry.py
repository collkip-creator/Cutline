"""Top-level PyInstaller entrypoint using absolute package imports for Tauri sidecar."""

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


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _setup_stdio_log()
    try:
        import uvicorn
        from clippah_core.ui.tauri_sidecar import app

        uvicorn.run(
            app,
            host="127.0.0.1",
            port=43111,
            log_config=None,
            access_log=False,
        )
    except Exception:
        traceback.print_exc()
        raise
