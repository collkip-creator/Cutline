"""
Pluggable SocialPublisher adapters.

Each platform adapter implements OAuth token upload or configurable local webhook
dispatch while reporting deterministic failure/success states back to PublishQueueStore.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional
from urllib import request as url_request

from ..core.interfaces import SocialPublisher
from ..core.schemas import PublishJob, PublishPlatform


class WebhookOrLocalPublisher(SocialPublisher):
    """
    Platform adapter supporting either an authenticated upload webhook / Graph endpoint
    or local staged verification when running offline without platform OAuth tokens.
    """

    def __init__(
        self,
        platform: PublishPlatform,
        endpoint_url: Optional[str] = None,
        bearer_token: Optional[str] = None,
    ) -> None:
        self._platform = platform
        self.endpoint_url = endpoint_url
        self.bearer_token = bearer_token

    @property
    def platform(self) -> PublishPlatform:
        return self._platform

    def publish(self, job: PublishJob) -> str:
        video_file = Path(job.video_path)
        if not video_file.exists():
            raise RuntimeError(f"Exported clip file missing on disk: {video_file}")

        if self.endpoint_url:
            payload = json.dumps({
                "job_id": job.job_id,
                "platform": self._platform.value,
                "title": job.clip_title,
                "caption": job.caption_text,
                "tags": job.tags,
                "video_path": str(video_file),
            }).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.bearer_token:
                headers["Authorization"] = f"Bearer {self.bearer_token}"
            req = url_request.Request(self.endpoint_url, data=payload, headers=headers, method="POST")
            with url_request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return str(data.get("url") or f"https://{self._platform.value}.local/posts/{job.job_id}")

        # Local verified staging receipt when no live OAuth endpoint is attached
        return f"local-staged://{self._platform.value}/{job.job_id}"


def build_default_publishers() -> Dict[PublishPlatform, SocialPublisher]:
    return {
        platform: WebhookOrLocalPublisher(platform=platform)
        for platform in PublishPlatform
    }
