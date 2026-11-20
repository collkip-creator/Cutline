"""
HighlightEngine adapter targeting local or LAN Ollama (/api/chat) with strict JSON schema.

Includes a zero-cloud deterministic heuristic fallback when no Ollama daemon is reachable,
allowing offline UI testing and constrained mobile fallback without cloud dependencies.
"""

from __future__ import annotations

import json
import re
from typing import List
from urllib import error as url_error
from urllib import request as url_request

from ..core.interfaces import HighlightEngine
from ..core.schemas import ClipCandidate, HighlightBatch, Transcript


HOOK_KEYWORDS = {
    "secret", "mistake", "never", "always", "why", "how", "truth", "actually",
    "fastest", "broken", "billion", "zero", "offline", "local", "architecture",
    "nobody", "stop", "instead", "benchmark", "latency", "memory", "crash",
}


class OllamaHighlightEngine(HighlightEngine):
    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "qwen2.5:14b",
        timeout_sec: float = 90.0,
        allow_heuristic_fallback: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_sec = timeout_sec
        self.allow_heuristic_fallback = allow_heuristic_fallback

    def _build_prompt(
        self,
        transcript: Transcript,
        user_prompt: str,
        min_clip_sec: float,
        max_clip_sec: float,
        max_clips: int,
    ) -> str:
        lines = [
            f"[{seg.start_sec:.2f} -> {seg.end_sec:.2f}] {seg.text}"
            for seg in transcript.segments
        ]
        transcript_block = "\n".join(lines)
        return (
            "You are a senior short-form video editor. Extract the strongest self-contained "
            f"clips between {min_clip_sec:.0f}s and {max_clip_sec:.0f}s.\n"
            f"Editor brief: {user_prompt}\n"
            f"Return at most {max_clips} clips as JSON matching the schema.\n"
            "Transcript:\n"
            f"{transcript_block}"
        )

    def extract_highlights(
        self,
        transcript: Transcript,
        user_prompt: str,
        min_clip_sec: float = 12.0,
        max_clip_sec: float = 60.0,
        max_clips: int = 8,
    ) -> HighlightBatch:
        payload = {
            "model": self.model,
            "stream": False,
            "format": HighlightBatch.model_json_schema(),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return strictly valid JSON matching HighlightBatch(clips=[...]). "
                        "Use exact start_sec and end_sec timestamps from the transcript."
                    ),
                },
                {
                    "role": "user",
                    "content": self._build_prompt(
                        transcript, user_prompt, min_clip_sec, max_clip_sec, max_clips
                    ),
                },
            ],
            "options": {"temperature": 0.2},
        }

        req = url_request.Request(
            f"{self.base_url}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with url_request.urlopen(req, timeout=self.timeout_sec) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                content = body.get("message", {}).get("content", "{}")
                return HighlightBatch.model_validate(json.loads(content))
        except (url_error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            if not self.allow_heuristic_fallback:
                raise RuntimeError(f"Ollama inference failed at {self.base_url}: {exc}") from exc
            return self._heuristic_extract(
                transcript, user_prompt, min_clip_sec, max_clip_sec, max_clips
            )

    def _heuristic_extract(
        self,
        transcript: Transcript,
        user_prompt: str,
        min_clip_sec: float,
        max_clip_sec: float,
        max_clips: int,
    ) -> HighlightBatch:
        """Offline deterministic scorer based on prompt term overlap, questions, and hook cadence."""
        segs = transcript.segments
        if not segs:
            return HighlightBatch(clips=[])

        prompt_terms = {
            t.lower()
            for t in re.findall(r"[a-zA-Z0-9]{3,}", user_prompt)
        }
        candidates: List[ClipCandidate] = []

        for i in range(len(segs)):
            window_segs = [segs[i]]
            j = i + 1
            while j < len(segs) and (segs[j].end_sec - segs[i].start_sec) <= max_clip_sec:
                window_segs.append(segs[j])
                if (segs[j].end_sec - segs[i].start_sec) >= min_clip_sec:
                    break
                j += 1

            dur = window_segs[-1].end_sec - window_segs[0].start_sec
            if dur < min(min_clip_sec, max(3.0, transcript.duration_sec * 0.25)):
                continue

            text = " ".join(s.text for s in window_segs)
            tokens = {t.lower() for t in re.findall(r"[a-zA-Z0-9']+", text)}
            hook_hits = len(tokens & HOOK_KEYWORDS)
            prompt_hits = len(tokens & prompt_terms)
            has_question = "?" in text
            has_number = bool(re.search(r"\b\d+", text))
            score = min(
                98.0,
                58.0 + hook_hits * 5.5 + prompt_hits * 7.0 + (6.0 if has_question else 0.0) + (4.5 if has_number else 0.0),
            )
            first_sentence = re.split(r"[.!?]", window_segs[0].text.strip())[0].strip()
            title = first_sentence[:56] if first_sentence else f"Clip {len(candidates) + 1}"
            tags = sorted(list((tokens & HOOK_KEYWORDS) | (tokens & prompt_terms)))[:4] or ["highlight", "local"]

            candidates.append(
                ClipCandidate(
                    id=f"clip_{i + 1:02d}",
                    title=title,
                    start_sec=window_segs[0].start_sec,
                    end_sec=window_segs[-1].end_sec,
                    hook_score=score,
                    reason=(
                        f"Matched {prompt_hits} brief terms and {hook_hits} retention cues"
                        + (" with direct question opener." if has_question else ".")
                    ),
                    caption_hook=first_sentence[:48].upper() if first_sentence else title.upper(),
                    tags=tags,
                )
            )

        candidates.sort(key=lambda c: c.hook_score, reverse=True)
        return HighlightBatch(clips=candidates[:max_clips])
