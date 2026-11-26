"""
JSON CLI bridge for `clippah_core`.

Allows headless invocation and direct integration from Node/Electron/Tauri dev backends
using the exact Python domain schemas, word-boundary grounding, SRT/ASS captioning,
FFmpeg export adapter, and SQLite PublishQueueStore.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .adapters.desktop_ffmpeg import FFmpegVideoProcessor
from .adapters.desktop_ollama import OllamaHighlightEngine
from .adapters.social_adapters import (
    build_publishers_from_store,
    test_webhook_endpoint,
)
from .core.captions import generate_ass, generate_srt
from .core.grounding import ground_and_deduplicate_clips, snap_clip_to_words
from .core.queue import PublishQueueStore
from .core.schemas import (
    AspectRatio,
    ClipCandidate,
    EncodeMode,
    ExportSpec,
    PublishPlatform,
    PublishStatus,
    SubtitleConfig,
    Transcript,
)


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def main() -> None:
    parser = argparse.ArgumentParser(prog="clippah-cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("snap", help="Snap a clip JSON payload to word boundaries")
    sub.add_parser("highlights", help="Run Ollama/offline highlight extraction + grounding")
    sub.add_parser("captions", help="Generate SRT & ASS captions for a clip")
    sub.add_parser("export", help="Render clip with FFmpegVideoProcessor")

    q_parser = sub.add_parser("queue", help="Manage SQLite PublishQueueStore")
    q_parser.add_argument("--db", required=True)
    q_parser.add_argument(
        "--action",
        choices=[
            "list",
            "enqueue",
            "process",
            "delete",
            "retry",
            "dispatch",
            "update",
            "channels-list",
            "channel-upsert",
            "channel-test",
        ],
        required=True,
    )
    q_parser.add_argument("--job-id", default="")
    q_parser.add_argument("--platform", default="")
    q_parser.add_argument("--include-future", action="store_true")

    args = parser.parse_args()

    if args.cmd == "snap":
        payload = _read_stdin_json()
        clip = ClipCandidate.model_validate(payload["clip"])
        transcript = Transcript.model_validate(payload["transcript"])
        snapped = snap_clip_to_words(clip, transcript)
        print(snapped.model_dump_json())
        return

    if args.cmd == "highlights":
        payload = _read_stdin_json()
        transcript = Transcript.model_validate(payload["transcript"])
        engine = OllamaHighlightEngine(
            base_url=payload.get("ollama_url", "http://localhost:11434"),
            model=payload.get("ollama_model", "qwen2.5:14b"),
            timeout_sec=float(payload.get("timeout_sec", 4.0)),
            allow_heuristic_fallback=True,
        )
        batch = engine.extract_highlights(
            transcript,
            user_prompt=payload.get("prompt", "High-retention hooks"),
            min_clip_sec=float(payload.get("min_clip_sec", 8.0)),
            max_clip_sec=float(payload.get("max_clip_sec", 45.0)),
            max_clips=int(payload.get("max_clips", 6)),
        )
        grounded = ground_and_deduplicate_clips(batch.clips, transcript)
        print(json.dumps([c.model_dump() for c in grounded]))
        return

    if args.cmd == "captions":
        payload = _read_stdin_json()
        clip = ClipCandidate.model_validate(payload["clip"])
        transcript = Transcript.model_validate(payload["transcript"]) if payload.get("transcript") else None
        subtitle_config = (
            SubtitleConfig.model_validate(payload["subtitle_config"])
            if payload.get("subtitle_config")
            else clip.subtitles
        )
        aspect = AspectRatio(payload.get("aspect_ratio", "9:16"))
        srt = generate_srt(clip, transcript, subtitle_config=subtitle_config)
        ass = generate_ass(clip, transcript, aspect_ratio=aspect, subtitle_config=subtitle_config)
        print(json.dumps({"srt": srt, "ass": ass}))
        return

    if args.cmd == "export":
        payload = _read_stdin_json()
        clip = ClipCandidate.model_validate(payload["clip"])
        transcript = Transcript.model_validate(payload["transcript"]) if payload.get("transcript") else None
        subtitle_config = (
            SubtitleConfig.model_validate(payload["subtitle_config"])
            if payload.get("subtitle_config")
            else clip.subtitles
        )
        aspect = AspectRatio(payload.get("aspect_ratio", "9:16"))
        encode_mode = EncodeMode(payload.get("encode_mode", "reencode"))
        include_srt = bool(payload.get("include_srt", True))
        burn_captions = bool(payload.get("burn_captions", True))
        if subtitle_config is not None and not subtitle_config.enabled:
            include_srt = False
            burn_captions = False
        spec = ExportSpec(
            clip=clip,
            aspect_ratio=aspect,
            encode_mode=encode_mode,
            include_srt=include_srt,
            burn_captions=burn_captions,
            subtitle_config=subtitle_config,
            output_dir=payload["output_dir"],
        )
        srt_text = generate_srt(clip, transcript, subtitle_config=subtitle_config) if include_srt else None
        ass_text = (
            generate_ass(clip, transcript, aspect_ratio=aspect, subtitle_config=subtitle_config)
            if burn_captions
            else None
        )
        processor = FFmpegVideoProcessor()
        result = processor.render_clip(
            Path(payload["source_path"]),
            spec,
            srt_content=srt_text,
            ass_content=ass_text,
        )
        print(result.model_dump_json())
        return

    if args.cmd == "queue":
        store = PublishQueueStore(Path(args.db))
        if args.action == "list":
            print(json.dumps([j.model_dump() for j in store.list_jobs()]))
        elif args.action == "enqueue":
            payload = _read_stdin_json()
            job = store.enqueue(
                clip_id=payload["clip_id"],
                clip_title=payload["clip_title"],
                video_path=payload["video_path"],
                srt_path=payload.get("srt_path"),
                platform=PublishPlatform(payload["platform"]),
                caption_text=payload["caption_text"],
                tags=payload.get("tags", []),
                scheduled_at_iso=payload.get("scheduled_at_iso"),
            )
            print(job.model_dump_json())
        elif args.action == "process":
            processed = store.process_due_jobs(
                build_publishers_from_store(store),
                include_future_scheduled=args.include_future,
            )
            print(json.dumps([j.model_dump() for j in processed]))
        elif args.action == "dispatch":
            updated = store.dispatch_job(args.job_id, build_publishers_from_store(store))
            print(updated.model_dump_json() if updated else "{}")
        elif args.action == "update":
            payload = _read_stdin_json()
            updated = store.update_job(
                args.job_id,
                caption_text=payload.get("caption_text"),
                tags=payload.get("tags"),
                platform=PublishPlatform(payload["platform"]) if payload.get("platform") else None,
                scheduled_at_iso=payload.get("scheduled_at_iso"),
                clear_schedule=bool(payload.get("clear_schedule", False)),
            )
            print(updated.model_dump_json() if updated else "{}")
        elif args.action == "channels-list":
            print(json.dumps(store.list_channels()))
        elif args.action == "channel-upsert":
            payload = _read_stdin_json()
            platform = PublishPlatform(args.platform or payload["platform"])
            updated = store.upsert_channel(
                platform,
                enabled=bool(payload.get("enabled", True)),
                endpoint_url=str(payload.get("endpoint_url", "")),
                bearer_token=payload.get("bearer_token"),
                payload_mode=str(payload.get("payload_mode", "multipart")),
                default_hashtags=payload.get("default_hashtags"),
            )
            print(json.dumps(updated))
        elif args.action == "channel-test":
            payload = _read_stdin_json()
            platform = PublishPlatform(args.platform or payload["platform"])
            cfg = store.get_channel(platform, include_secret=True)
            endpoint = str(payload.get("endpoint_url") or cfg.get("endpoint_url") or "")
            token = payload.get("bearer_token") if payload.get("bearer_token") is not None else cfg.get("bearer_token")
            print(json.dumps(test_webhook_endpoint(platform, endpoint, token)))
        elif args.action == "delete":
            ok = store.delete_job(args.job_id)
            print(json.dumps({"deleted": ok}))
        elif args.action == "retry":
            updated = store.update_status(args.job_id, PublishStatus.QUEUED, error_message=None)
            print(updated.model_dump_json() if updated else "{}")


if __name__ == "__main__":
    main()
