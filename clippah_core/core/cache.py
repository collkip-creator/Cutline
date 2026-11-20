"""
Content-addressed transcript caching.

Stores word-timestamped Transcript JSON keyed by (video_hash, model_identifier)
so iterating on highlight prompts never re-runs expensive Whisper ASR.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional

from .schemas import Transcript


def compute_file_sha256(file_path: Path, chunk_bytes: int = 1024 * 1024) -> str:
    hasher = hashlib.sha256()
    with file_path.open("rb") as fh:
        while chunk := fh.read(chunk_bytes):
            hasher.update(chunk)
    return hasher.hexdigest()


class TranscriptCache:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _entry_path(self, video_hash: str, model_key: Optional[str] = None) -> Path:
        if model_key:
            safe_model = "".join(c if c.isalnum() or c in "-_" else "_" for c in model_key)
            return self.cache_dir / f"{video_hash}__{safe_model}.json"
        return self.cache_dir / f"{video_hash}.json"

    def _load_file(self, path: Path) -> Optional[Transcript]:
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            return Transcript.model_validate(data)
        except Exception:
            return None

    def get(self, video_hash: str, model_key: Optional[str] = None) -> Optional[Transcript]:
        specific = self._entry_path(video_hash, model_key)
        if specific.exists():
            loaded = self._load_file(specific)
            if loaded is not None:
                return loaded

        # Fallback: return any cached transcript for this video hash
        matches = sorted(self.cache_dir.glob(f"{video_hash}*.json"))
        for match in matches:
            loaded = self._load_file(match)
            if loaded is not None:
                return loaded
        return None

    def put(self, transcript: Transcript, model_key: Optional[str] = None) -> Path:
        target = self._entry_path(transcript.video_hash, model_key or transcript.model_name)
        target.write_text(transcript.model_dump_json(indent=2), encoding="utf-8")
        return target
