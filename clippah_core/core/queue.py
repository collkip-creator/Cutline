"""
SQLite-backed scheduled & direct social publish queue.

Uses Python's built-in `sqlite3` (zero external deps, runs identically on desktop
and Android Chaquopy/Python embeds) with atomic status transitions.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import sqlite3
from typing import Any, Dict, List, Optional
import uuid

from .interfaces import SocialPublisher
from .schemas import PublishJob, PublishPlatform, PublishStatus

DEFAULT_CHANNEL_HASHTAGS: Dict[PublishPlatform, List[str]] = {
    PublishPlatform.YOUTUBE_SHORTS: ["Shorts"],
    PublishPlatform.TIKTOK: ["fyp", "viral"],
    PublishPlatform.INSTAGRAM_REELS: ["reels"],
    PublishPlatform.X_VIDEO: [],
}


class PublishQueueStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS publish_jobs (
                    job_id TEXT PRIMARY KEY,
                    clip_id TEXT NOT NULL,
                    clip_title TEXT NOT NULL,
                    video_path TEXT NOT NULL,
                    srt_path TEXT,
                    platform TEXT NOT NULL,
                    caption_text TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL,
                    scheduled_at_iso TEXT,
                    created_at_iso TEXT NOT NULL,
                    updated_at_iso TEXT NOT NULL,
                    published_url TEXT,
                    error_message TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_publish_status ON publish_jobs(status, scheduled_at_iso)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS publish_channels (
                    platform TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    endpoint_url TEXT NOT NULL DEFAULT '',
                    bearer_token TEXT NOT NULL DEFAULT '',
                    payload_mode TEXT NOT NULL DEFAULT 'multipart',
                    default_hashtags_json TEXT NOT NULL DEFAULT '[]',
                    updated_at_iso TEXT NOT NULL
                )
                """
            )

    def _row_to_job(self, row: sqlite3.Row) -> PublishJob:
        return PublishJob(
            job_id=row["job_id"],
            clip_id=row["clip_id"],
            clip_title=row["clip_title"],
            video_path=row["video_path"],
            srt_path=row["srt_path"],
            platform=PublishPlatform(row["platform"]),
            caption_text=row["caption_text"],
            tags=json.loads(row["tags_json"] or "[]"),
            status=PublishStatus(row["status"]),
            scheduled_at_iso=row["scheduled_at_iso"],
            created_at_iso=row["created_at_iso"],
            updated_at_iso=row["updated_at_iso"],
            published_url=row["published_url"],
            error_message=row["error_message"],
            attempts=int(row["attempts"]),
        )

    def _row_to_channel(self, platform: PublishPlatform, row: Optional[sqlite3.Row]) -> Dict[str, Any]:
        if row is None:
            return {
                "platform": platform.value,
                "enabled": True,
                "endpoint_url": "",
                "has_token": False,
                "token_preview": "",
                "payload_mode": "multipart",
                "default_hashtags": list(DEFAULT_CHANNEL_HASHTAGS.get(platform, [])),
                "updated_at_iso": None,
            }
        token = str(row["bearer_token"] or "")
        return {
            "platform": platform.value,
            "enabled": bool(row["enabled"]),
            "endpoint_url": str(row["endpoint_url"] or ""),
            "has_token": bool(token),
            "token_preview": f"...{token[-4:]}" if len(token) >= 4 else ("***" if token else ""),
            "payload_mode": str(row["payload_mode"] or "multipart"),
            "default_hashtags": json.loads(row["default_hashtags_json"] or "[]"),
            "updated_at_iso": row["updated_at_iso"],
        }

    def list_channels(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM publish_channels").fetchall()
        by_platform = {str(r["platform"]): r for r in rows}
        return [self._row_to_channel(p, by_platform.get(p.value)) for p in PublishPlatform]

    def get_channel(self, platform: PublishPlatform, include_secret: bool = False) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM publish_channels WHERE platform = ?",
                (platform.value,),
            ).fetchone()
        data = self._row_to_channel(platform, row)
        if include_secret:
            data["bearer_token"] = str(row["bearer_token"] or "") if row else ""
        return data

    def upsert_channel(
        self,
        platform: PublishPlatform,
        *,
        enabled: bool = True,
        endpoint_url: str = "",
        bearer_token: Optional[str] = None,
        payload_mode: str = "multipart",
        default_hashtags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        existing = self.get_channel(platform, include_secret=True)
        resolved_token = existing.get("bearer_token", "") if bearer_token is None else bearer_token.strip()
        resolved_mode = payload_mode if payload_mode in ("multipart", "json") else "multipart"
        resolved_tags = (
            [t.strip().lstrip("#") for t in default_hashtags if t.strip()]
            if default_hashtags is not None
            else existing.get("default_hashtags", [])
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO publish_channels (
                    platform, enabled, endpoint_url, bearer_token, payload_mode, default_hashtags_json, updated_at_iso
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(platform) DO UPDATE SET
                    enabled = excluded.enabled,
                    endpoint_url = excluded.endpoint_url,
                    bearer_token = excluded.bearer_token,
                    payload_mode = excluded.payload_mode,
                    default_hashtags_json = excluded.default_hashtags_json,
                    updated_at_iso = excluded.updated_at_iso
                """,
                (
                    platform.value,
                    1 if enabled else 0,
                    endpoint_url.strip(),
                    resolved_token,
                    resolved_mode,
                    json.dumps(resolved_tags),
                    now,
                ),
            )
        return self.get_channel(platform)

    def enqueue(
        self,
        *,
        clip_id: str,
        clip_title: str,
        video_path: str,
        platform: PublishPlatform,
        caption_text: str,
        tags: Optional[List[str]] = None,
        srt_path: Optional[str] = None,
        scheduled_at_iso: Optional[str] = None,
    ) -> PublishJob:
        now = datetime.now(timezone.utc).isoformat()
        status = PublishStatus.SCHEDULED if scheduled_at_iso else PublishStatus.QUEUED
        job = PublishJob(
            job_id=f"job_{uuid.uuid4().hex[:10]}",
            clip_id=clip_id,
            clip_title=clip_title,
            video_path=video_path,
            srt_path=srt_path,
            platform=platform,
            caption_text=caption_text,
            tags=tags or [],
            status=status,
            scheduled_at_iso=scheduled_at_iso,
            created_at_iso=now,
            updated_at_iso=now,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO publish_jobs (
                    job_id, clip_id, clip_title, video_path, srt_path, platform,
                    caption_text, tags_json, status, scheduled_at_iso,
                    created_at_iso, updated_at_iso, published_url, error_message, attempts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.job_id,
                    job.clip_id,
                    job.clip_title,
                    job.video_path,
                    job.srt_path,
                    job.platform.value,
                    job.caption_text,
                    json.dumps(job.tags),
                    job.status.value,
                    job.scheduled_at_iso,
                    job.created_at_iso,
                    job.updated_at_iso,
                    job.published_url,
                    job.error_message,
                    job.attempts,
                ),
            )
        return job

    def list_jobs(self, status_filter: Optional[PublishStatus] = None) -> List[PublishJob]:
        with self._connect() as conn:
            if status_filter:
                rows = conn.execute(
                    "SELECT * FROM publish_jobs WHERE status = ? ORDER BY created_at_iso DESC",
                    (status_filter.value,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM publish_jobs ORDER BY created_at_iso DESC"
                ).fetchall()
        return [self._row_to_job(r) for r in rows]

    def get_job(self, job_id: str) -> Optional[PublishJob]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM publish_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._row_to_job(row) if row else None

    def update_job(
        self,
        job_id: str,
        *,
        caption_text: Optional[str] = None,
        tags: Optional[List[str]] = None,
        platform: Optional[PublishPlatform] = None,
        scheduled_at_iso: Optional[str] = None,
        clear_schedule: bool = False,
    ) -> Optional[PublishJob]:
        existing = self.get_job(job_id)
        if existing is None:
            return None
        now = datetime.now(timezone.utc).isoformat()
        next_caption = existing.caption_text if caption_text is None else caption_text
        next_tags = existing.tags if tags is None else tags
        next_platform = existing.platform if platform is None else platform
        next_sched = None if clear_schedule else (existing.scheduled_at_iso if scheduled_at_iso is None else scheduled_at_iso)
        next_status = existing.status
        if existing.status in (PublishStatus.QUEUED, PublishStatus.SCHEDULED):
            next_status = PublishStatus.SCHEDULED if next_sched else PublishStatus.QUEUED
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE publish_jobs
                SET caption_text = ?, tags_json = ?, platform = ?, scheduled_at_iso = ?, status = ?, updated_at_iso = ?
                WHERE job_id = ?
                """,
                (
                    next_caption,
                    json.dumps(next_tags),
                    next_platform.value,
                    next_sched,
                    next_status.value,
                    now,
                    job_id,
                ),
            )
        return self.get_job(job_id)

    def update_status(
        self,
        job_id: str,
        status: PublishStatus,
        *,
        published_url: Optional[str] = None,
        error_message: Optional[str] = None,
        increment_attempts: bool = False,
    ) -> Optional[PublishJob]:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            if increment_attempts:
                conn.execute(
                    """
                    UPDATE publish_jobs
                    SET status = ?, updated_at_iso = ?, published_url = COALESCE(?, published_url),
                        error_message = ?, attempts = attempts + 1
                    WHERE job_id = ?
                    """,
                    (status.value, now, published_url, error_message, job_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE publish_jobs
                    SET status = ?, updated_at_iso = ?, published_url = COALESCE(?, published_url),
                        error_message = ?
                    WHERE job_id = ?
                    """,
                    (status.value, now, published_url, error_message, job_id),
                )
        return self.get_job(job_id)

    def delete_job(self, job_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM publish_jobs WHERE job_id = ?", (job_id,))
            return cur.rowcount > 0

    def _dispatch_one(
        self,
        job: PublishJob,
        publishers: Dict[PublishPlatform, SocialPublisher],
    ) -> Optional[PublishJob]:
        adapter = publishers.get(job.platform)
        if adapter is None:
            return self.update_status(
                job.job_id,
                PublishStatus.FAILED,
                error_message=f"No SocialPublisher adapter registered for {job.platform.value}",
                increment_attempts=True,
            )

        self.update_status(job.job_id, PublishStatus.PUBLISHING, increment_attempts=True)
        try:
            url = adapter.publish(job)
            return self.update_status(
                job.job_id,
                PublishStatus.PUBLISHED,
                published_url=url,
                error_message=None,
            )
        except Exception as exc:  # noqa: BLE001
            return self.update_status(
                job.job_id,
                PublishStatus.FAILED,
                error_message=str(exc),
            )

    def dispatch_job(
        self,
        job_id: str,
        publishers: Dict[PublishPlatform, SocialPublisher],
    ) -> Optional[PublishJob]:
        job = self.get_job(job_id)
        if job is None:
            return None
        return self._dispatch_one(job, publishers)

    def process_due_jobs(
        self,
        publishers: Dict[PublishPlatform, SocialPublisher],
        now_utc: Optional[datetime] = None,
        include_future_scheduled: bool = False,
    ) -> List[PublishJob]:
        now = now_utc or datetime.now(timezone.utc)
        processed: List[PublishJob] = []
        for job in self.list_jobs():
            if job.status not in (PublishStatus.QUEUED, PublishStatus.SCHEDULED):
                continue
            if job.status == PublishStatus.SCHEDULED and job.scheduled_at_iso and not include_future_scheduled:
                try:
                    sched = datetime.fromisoformat(job.scheduled_at_iso.replace("Z", "+00:00"))
                    if sched.tzinfo is None:
                        sched = sched.replace(tzinfo=timezone.utc)
                    if sched > now:
                        continue
                except ValueError:
                    pass

            updated = self._dispatch_one(job, publishers)
            if updated:
                processed.append(updated)
        return processed
