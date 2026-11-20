# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for bundling `clippah_core/ui/tauri_sidecar.py` into a standalone
Windows sidecar executable (`cutline-sidecar-x86_64-pc-windows-msvc.exe`).
"""

from pathlib import Path

ROOT = Path(SPECPATH).resolve().parents[2]

a = Analysis(
    [str(ROOT / "clippah_core" / "ui" / "tauri_sidecar.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.lifespan.on",
        "faster_whisper",
        "ctranslate2",
        "pydantic",
        "multipart",
    ],
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
