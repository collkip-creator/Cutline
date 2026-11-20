# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for bundling `clippah_core/ui/tauri_sidecar.py` into a standalone
Windows sidecar executable (`cutline-sidecar-x86_64-pc-windows-msvc.exe`).
"""

from pathlib import Path
from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).resolve().parents[2]

fw_datas, fw_bins, fw_hidden = collect_all("faster_whisper")
ct_datas, ct_bins, ct_hidden = collect_all("ctranslate2")

a = Analysis(
    [str(ROOT / "clippah_core" / "packaging" / "tauri_windows" / "sidecar_entry.py")],
    pathex=[str(ROOT)],
    binaries=fw_bins + ct_bins,
    datas=fw_datas + ct_datas,
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "pydantic",
        "multipart",
        "python_multipart",
        "python_multipart.multipart",
        "starlette.staticfiles",
        "anyio._backends._asyncio",
    ] + fw_hidden + ct_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["PyQt6", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="cutline-sidecar-x86_64-pc-windows-msvc",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)
