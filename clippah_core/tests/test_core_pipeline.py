from pathlib import Path
import tempfile
import unittest

from clippah_core.adapters.desktop_ollama import OllamaHighlightEngine
from clippah_core.adapters.social_adapters import build_default_publishers
from clippah_core.core.cache import TranscriptCache
from clippah_core.core.captions import generate_ass, generate_srt
from clippah_core.core.grounding import ground_and_deduplicate_clips, snap_clip_to_words
from clippah_core.core.queue import PublishQueueStore
from clippah_core.core.schemas import (
    AspectRatio,
    ClipCandidate,
    PublishPlatform,
    PublishStatus,
    Transcript,
    TranscriptSegment,
    WordTimestamp,
)


def _sample_transcript() -> Transcript:
    return Transcript(
        video_hash="abc123def456",
        source_path="/tmp/sample.mp4",
        duration_sec=36.0,
        segments=[
            TranscriptSegment(
                id=0,
                start_sec=0.5,
                end_sec=7.2,
                text="Why do cloud video pipelines fail when bandwidth drops?",
                words=[
                    WordTimestamp(word="Why", start_sec=0.50, end_sec=0.80),
                    WordTimestamp(word="do", start_sec=0.85, end_sec=1.05),
                    WordTimestamp(word="cloud", start_sec=1.10, end_sec=1.55),
                    WordTimestamp(word="video", start_sec=1.60, end_sec=2.05),
                    WordTimestamp(word="pipelines", start_sec=2.10, end_sec=2.85),
                    WordTimestamp(word="fail", start_sec=2.90, end_sec=3.35),
                    WordTimestamp(word="when", start_sec=3.40, end_sec=3.75),
                    WordTimestamp(word="bandwidth", start_sec=3.80, end_sec=4.60),
                    WordTimestamp(word="drops?", start_sec=4.65, end_sec=5.30),
                ],
            ),
            TranscriptSegment(
                id=1,
                start_sec=8.0,
                end_sec=19.5,
                text="Keeping transcription local with faster-whisper eliminates latency and protects privacy.",
                words=[
                    WordTimestamp(word="Keeping", start_sec=8.10, end_sec=8.60),
                    WordTimestamp(word="transcription", start_sec=8.65, end_sec=9.50),
                    WordTimestamp(word="local", start_sec=9.55, end_sec=10.00),
                    WordTimestamp(word="with", start_sec=10.05, end_sec=10.30),
                    WordTimestamp(word="faster-whisper", start_sec=10.35, end_sec=11.40),
                    WordTimestamp(word="eliminates", start_sec=11.45, end_sec=12.20),
                    WordTimestamp(word="latency", start_sec=12.25, end_sec=13.00),
                    WordTimestamp(word="and", start_sec=13.05, end_sec=13.25),
                    WordTimestamp(word="protects", start_sec=13.30, end_sec=14.00),
                    WordTimestamp(word="privacy.", start_sec=14.05, end_sec=14.80),
                ],
            ),
        ],
    )


class CorePipelineTests(unittest.TestCase):
    def test_word_boundary_snapping(self) -> None:
        transcript = _sample_transcript()
        raw_clip = ClipCandidate(
            id="clip_01",
            title="Cloud pipelines fail",
            start_sec=0.68,  # mid-word inside "Why"
            end_sec=14.52,   # mid-word inside "privacy."
            hook_score=88.5,
            reason="Strong opening question",
            caption_hook="WHY CLOUD PIPELINES FAIL",
            tags=["local", "whisper"],
        )
        snapped = snap_clip_to_words(raw_clip, transcript)
        self.assertTrue(snapped.snapped_to_words)
        self.assertLessEqual(snapped.start_sec, 0.50)
        self.assertGreaterEqual(snapped.end_sec, 14.80)

    def test_deduplicate_overlapping_clips(self) -> None:
        transcript = _sample_transcript()
        c1 = ClipCandidate(
            id="a", title="A", start_sec=0.5, end_sec=14.8,
            hook_score=91.0, reason="Best", caption_hook="BEST", tags=[],
        )
        c2 = ClipCandidate(
            id="b", title="B", start_sec=1.0, end_sec=14.5,
            hook_score=74.0, reason="Duplicate", caption_hook="DUP", tags=[],
        )
        kept = ground_and_deduplicate_clips([c1, c2], transcript)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].id, "a")

    def test_captions_relative_timestamps(self) -> None:
        transcript = _sample_transcript()
        clip = ClipCandidate(
            id="c1", title="Local Whisper", start_sec=8.0, end_sec=15.0,
            hook_score=84.0, reason="Clear", caption_hook="LOCAL WHISPER", tags=[],
        )
        srt = generate_srt(clip, transcript)
        self.assertIn("00:00:00,", srt)
        self.assertIn("Keeping transcription local", srt)
        ass = generate_ass(clip, transcript, aspect_ratio=AspectRatio.VERTICAL_9_16)
        self.assertIn("PlayResX: 1080", ass)
        self.assertIn("LOCAL WHISPER", ass)

    def test_transcript_cache_roundtrip(self) -> None:
        transcript = _sample_transcript()
        with tempfile.TemporaryDirectory() as tmp:
            cache = TranscriptCache(Path(tmp))
            cache.put(transcript, "faster-whisper-small-int8")
            hit = cache.get(transcript.video_hash, "faster-whisper-small-int8")
            self.assertIsNotNone(hit)
            self.assertEqual(hit.video_hash, transcript.video_hash)  # type: ignore[union-attr]
            self.assertEqual(len(hit.all_words()), 19)  # type: ignore[union-attr]

    def test_sqlite_publish_queue_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_mp4 = tmp_path / "clip.mp4"
            fake_mp4.write_bytes(b"ftypmp42")
            store = PublishQueueStore(tmp_path / "queue.db")
            job = store.enqueue(
                clip_id="clip_01",
                clip_title="Local First Demo",
                video_path=str(fake_mp4),
                platform=PublishPlatform.YOUTUBE_SHORTS,
                caption_text="Why local AI wins",
                tags=["local", "ai"],
            )
            self.assertEqual(job.status, PublishStatus.QUEUED)
            processed = store.process_due_jobs(build_default_publishers())
            self.assertEqual(len(processed), 1)
            self.assertEqual(processed[0].status, PublishStatus.PUBLISHED)
            self.assertIn("local-staged://youtube_shorts/", processed[0].published_url or "")

    def test_heuristic_highlight_fallback(self) -> None:
        transcript = _sample_transcript()
        engine = OllamaHighlightEngine(base_url="http://127.0.0.1:1", timeout_sec=0.2)
        batch = engine.extract_highlights(
            transcript,
            user_prompt="local transcription privacy latency",
            min_clip_sec=4.0,
            max_clip_sec=20.0,
        )
        self.assertGreaterEqual(len(batch.clips), 1)


if __name__ == "__main__":
    unittest.main()
