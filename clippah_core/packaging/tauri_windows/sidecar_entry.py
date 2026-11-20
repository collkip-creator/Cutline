"""Top-level PyInstaller entrypoint using absolute package imports for Tauri sidecar."""

import multiprocessing
import uvicorn

from clippah_core.ui.tauri_sidecar import app


if __name__ == "__main__":
    multiprocessing.freeze_support()
    uvicorn.run(app, host="127.0.0.1", port=43111, log_level="info")
