"""
Pluggable SocialPublisher adapters.

Each platform adapter supports either:
1. Authenticated webhook / automation upload (`multipart/form-data` with the real MP4 + SRT files,
   or `json` metadata payload for n8n, Make, Zapier, Discord, or custom upload servers), or
2. Deterministic local staging receipts when running offline without an external endpoint.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib import error as url_error
from urllib import request as url_request
import uuid

from ..core.interfaces import SocialPublisher
from ..core.queue import PublishQueueStore
from ..core.schemas import PublishJob, PublishPlatform


def format_full_post_text(caption_text: str, tags: Iterable[str]) -> str:
    clean_tags = [f"#{t.strip().lstrip('#')}" for t in tags if t and t.strip()]
    base = (caption_text or "").strip()
    if not clean_tags:
        return base
    tag_line = " ".join(clean_tags)
    return f"{base}\n\n{tag_line}" if base else tag_line


def encode_multipart_form_data(
    fields: Dict[str, str],
    files: List[Tuple[str, str, str, bytes]],
    boundary: Optional[str] = None,
) -> Tuple[bytes, str]:
    """
    Pure-stdlib multipart/form-data encoder:
    files items are (field_name, filename, content_type, data_bytes).
    Returns (body_bytes, content_type_header).
    """
    bnd = boundary or f"----CutlineBoundary{uuid.uuid4().hex}"
    chunks: List[bytes] = []

    for name, value in fields.items():
        chunks.append(f"--{bnd}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    for field_name, filename, content_type, data in files:
        safe_name = filename.replace('"', "_")
        chunks.append(f"--{bnd}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{field_name}"; '
                f'filename="{safe_name}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(data)
        chunks.append(b"\r\n")

    chunks.append(f"--{bnd}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={bnd}"


class WebhookOrLocalPublisher(SocialPublisher):
    """
    Platform adapter supporting either an authenticated upload webhook / Graph endpoint
    (with multipart MP4 binary upload or JSON payload) or local staged verification.
    """

    def __init__(
        self,
        platform: PublishPlatform,
        endpoint_url: Optional[str] = None,
        bearer_token: Optional[str] = None,
        payload_mode: str = "multipart",
        enabled: bool = True,
    ) -> None:
        self._platform = platform
        self.endpoint_url = (endpoint_url or "").strip() or None
        self.bearer_token = (bearer_token or "").strip() or None
        self.payload_mode = payload_mode if payload_mode in ("multipart", "json") else "multipart"
        self.enabled = enabled

    @property
    def platform(self) -> PublishPlatform:
        return self._platform

    def publish(self, job: PublishJob) -> str:
        video_file = Path(job.video_path)
        if not video_file.exists():
            raise RuntimeError(f"Exported clip file missing on disk: {video_file}")

        if not self.enabled and self.endpoint_url:
            raise RuntimeError(
                f"Channel {self._platform.value} is currently disabled in Publish Connectors"
            )

        if self.endpoint_url:
            full_post = format_full_post_text(job.caption_text, job.tags)
            headers: Dict[str, str] = {"User-Agent": "CutlineStudio/0.1"}
            if self.bearer_token:
                headers["Authorization"] = f"Bearer {self.bearer_token}"

            if self.payload_mode == "multipart":
                fields = {
                    "job_id": job.job_id,
                    "clip_id": job.clip_id,
                    "platform": self._platform.value,
                    "title": job.clip_title,
                    "caption": job.caption_text,
                    "tags_json": json.dumps(job.tags),
                    "full_post_text": full_post,
                    "scheduled_at_iso": job.scheduled_at_iso or "",
                }
                files: List[Tuple[str, str, str, bytes]] = [
                    ("video", video_file.name, "video/mp4", video_file.read_bytes())
                ]
                if job.srt_path:
                    srt_file = Path(job.srt_path)
                    if srt_file.exists():
                        files.append(("subtitles", srt_file.name, "application/x-subrip", srt_file.read_bytes()))
                body, content_type = encode_multipart_form_data(fields, files)
                headers["Content-Type"] = content_type
            else:
                body = json.dumps(
                    {
                        "job_id": job.job_id,
                        "clip_id": job.clip_id,
                        "platform": self._platform.value,
                        "title": job.clip_title,
                        "caption": job.caption_text,
                        "tags": job.tags,
                        "full_post_text": full_post,
                        "video_path": str(video_file),
                        "srt_path": job.srt_path,
                        "scheduled_at_iso": job.scheduled_at_iso,
                    }
                ).encode("utf-8")
                headers["Content-Type"] = "application/json"

            req = url_request.Request(self.endpoint_url, data=body, headers=headers, method="POST")
            with url_request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8", errors="replace").strip()
                try:
                    data = json.loads(raw) if raw else {}
                    if isinstance(data, dict) and data.get("url"):
                        return str(data["url"])
                except json.JSONDecodeError:
                    pass
                return f"webhook://{self._platform.value}/{job.job_id}"

        # Local verified staging receipt when no external webhook endpoint is attached
        return f"local-staged://{self._platform.value}/{job.job_id}"


def build_default_publishers() -> Dict[PublishPlatform, SocialPublisher]:
    return {
        platform: WebhookOrLocalPublisher(platform=platform)
        for platform in PublishPlatform
    }


def build_publishers_from_store(store: PublishQueueStore) -> Dict[PublishPlatform, SocialPublisher]:
    publishers: Dict[PublishPlatform, SocialPublisher] = {}
    for platform in PublishPlatform:
        cfg = store.get_channel(platform, include_secret=True)
        publishers[platform] = WebhookOrLocalPublisher(
            platform=platform,
            endpoint_url=cfg.get("endpoint_url") or None,
            bearer_token=cfg.get("bearer_token") or None,
            payload_mode=cfg.get("payload_mode") or "multipart",
            enabled=bool(cfg.get("enabled", True)),
        )
    return publishers


def test_webhook_endpoint(
    platform: PublishPlatform,
    endpoint_url: str,
    bearer_token: Optional[str] = None,
) -> Dict[str, Any]:
    url = endpoint_url.strip()
    if not url:
        return {"ok": False, "status_code": None, "message": "Enter a webhook endpoint URL first."}

    payload = json.dumps(
        {
            "event": "cutline_webhook_test",
            "platform": platform.value,
            "message": "Cutline Studio connection verification ping.",
        }
    ).encode("utf-8")
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "User-Agent": "CutlineStudio/0.1",
    }
    if bearer_token and bearer_token.strip():
        headers["Authorization"] = f"Bearer {bearer_token.strip()}"

    req = url_request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with url_request.urlopen(req, timeout=15) as resp:
            code = getattr(resp, "status", 200)
            return {
                "ok": 200 <= code < 300,
                "status_code": code,
                "message": f"Webhook reachable (HTTP {code}).",
            }
    except url_error.HTTPError as exc:
        return {
            "ok": False,
            "status_code": exc.code,
            "message": f"Endpoint returned HTTP {exc.code}: {exc.reason}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "status_code": None,
            "message": f"Connection failed: {exc}",
        }
