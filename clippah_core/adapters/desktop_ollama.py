"""
HighlightEngine adapter targeting local or LAN Ollama (/api/chat) with strict JSON schema.

Enforces senior short-form editorial strategy across three dimensions:
  1. Lessons & Takeaways (`lesson`)
  2. Entertainment (`entertainment`)
  3. Interesting Hooks & Insights (`insight` / `hook`)

Includes a multi-dimensional offline strategist fallback when no Ollama daemon is
reachable, filtering low-signal filler, completing full narrative arcs, scoring
honestly on a 1-10 scale, and selecting diverse non-overlapping clips.
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Optional, Set, Tuple
from urllib import request as url_request

from ..core.interfaces import HighlightEngine
from ..core.schemas import ClipCandidate, ClipCategory, HighlightBatch, Transcript
from ..core.viral_intelligence import (
    CATEGORY_PROFILES,
    VideoCategory,
    build_category_prompt_block,
    detect_gaming_focus_for_segment,
    detect_video_category,
    evaluate_text_for_category,
)

SENIOR_EDITOR_SYSTEM_PROMPT = """You are a senior short-form video editor and content strategist with Category-Specific Viral Intelligence. Your job is to identify the video's primary category and read the timestamped transcript to select the strongest standalone clips across three core editorial dimensions: interesting moments, actionable lessons, and entertainment.

### Category-Specific Viral Intelligence
Automatically identify the video category (`business`, `comedy`, `motivation`, `politics`, `sports`, `relationships`, `technology`, `education`, `gaming`, or `general`) and prioritize moments hitting the matching domain rules:
- BUSINESS: financial revelations, entrepreneurial mistakes, business strategies, lessons from failure, unpopular business opinions, success stories.
- COMEDY: punchlines, unexpected humour, funny reactions, sarcasm, awkward moments, humorous conversations.
- MOTIVATION: powerful life lessons, personal transformation, adversity, inspirational stories, memorable statements.
- POLITICS: debates, contradictions, powerful arguments, unexpected admissions, controversial public statements.
- SPORTS: remarkable performances, rivalry, emotional reactions, tactical insights, unexpected predictions.
- RELATIONSHIPS: relatable experiences, disagreements, dating experiences, relationship advice, emotional revelations.
- TECHNOLOGY: surprising demonstrations, future predictions, misconceptions, technological discoveries, useful explanations.
- EDUCATION: simplified explanations, interesting facts, misconceptions, practical demonstrations, knowledge with immediate learning benefit.
- GAMING (Viral trigger: Excitement + skill + humour + surprise + competition): extraordinary skills/gameplay, unexpected victories/comebacks, funny fails/mishaps, intense player reactions/rage/celebrations, epic battles/clutch plays/last-second wins, plot twists/discoveries, strategies/shortcuts/hidden mechanics, competitive rivalries/trash talk, glitches/hilarious physics, multiplayer encounters, speedruns/world-firsts/records, secrets/Easter eggs, character/storyline emotional moments, unusual challenges.
  * For GAMING: explicitly distinguish `gaming_clip_type` between `gameplay_highlight` (in-game action) and `commentary_highlight` (player voice/reaction/commentary), and wherever important gameplay events occur with or right before player reactions, synchronize both into a `synced_gameplay_reaction` clip!

### What Makes a Clip Worth Taking
1. Lessons & Takeaways (`lesson`): Clear frameworks, step-by-step advice, counterintuitive rules, mistakes to avoid, or "aha!" explanations where the viewer walks away knowing something practical.
2. Entertainment (`entertainment`): Jokes, banter, funny stories, dramatic reactions, roast/callout moments, surprising twists, or high-energy storytelling that holds attention purely through personality and delivery.
3. Interesting Hooks & Insights (`insight` / `hook`): Bold claims, strong opinions, intriguing questions, rare observations, or vivid real-world examples that spark curiosity immediately.

### Strict Editing & Selection Rules
- Complete Arc Only: Every clip must have a clear setup/hook, a payoff/point, and a clean ending. Never cut off mid-sentence or end right before the punchline/takeaway lands.
- Timestamp Grounding: Use ONLY start and end times present in the transcript. Never invent timestamps beyond total video duration.
- Duration & Spacing: Keep clips within the requested min/max seconds, avoid overlapping clips, and prioritize variety.
- Reject Low-Signal Filler: Skip sponsor reads, "like/subscribe/follow" reminders, mic/audio checks, long throat-clearing intros, and vague rambling unless explicitly requested.
- Score Honestly: Rate `hook_score`, `lesson_score`, and `entertainment_score` from 1 to 10.

### Output Format
Return ONLY valid JSON matching HighlightBatch(detected_video_category, category_reason, clips=[...]) with category in {"lesson","entertainment","insight","hook"}, video_category, viral_triggers, optional gaming_clip_type, and 1-10 scores."""

HOOK_KEYWORDS = {
    "secret", "mistake", "never", "always", "why", "how", "truth", "actually",
    "fastest", "broken", "billion", "zero", "offline", "local", "architecture",
    "nobody", "stop", "instead", "benchmark", "latency", "memory", "crash",
    "surprising", "real", "myth", "unpopular", "example", "imagine", "exactly",
}

LESSON_KEYWORDS = {
    "step", "rule", "framework", "lesson", "avoid", "mistake", "principle",
    "strategy", "learn", "learned", "because", "reason", "solution", "instead",
    "always", "never", "first", "second", "third", "secret", "formula", "habit",
    "system", "workflow", "how", "fix", "protect", "protects", "eliminates",
}

ENTERTAINMENT_KEYWORDS = {
    "haha", "lol", "lmao", "funny", "hilarious", "joke", "banter", "roast",
    "crazy", "insane", "wild", "ridiculous", "disaster", "awkward", "twist",
    "story", "laughed", "screaming", "wait", "literally", "bro", "dude", "man",
    "absurd", "chaos", "dramatic", "reaction", "burned", "exploded",
}

FILLER_PHRASES = (
    "sponsored by",
    "today's sponsor",
    "promo code",
    "use code",
    "discount code",
    "check out the link",
    "link in the description",
    "like and subscribe",
    "hit that subscribe",
    "smash that like",
    "hit the bell",
    "follow me on",
    "subscribe to the channel",
    "drop a comment",
    "can you hear me",
    "mic check",
    "audio check",
    "testing one two",
    "test test",
    "is this recording",
    "welcome back to the channel",
    "hey guys welcome back",
    "before we get started",
    "let me share my screen",
)

WEAK_OPENER_PREFIXES = ("and ", "but ", "so yeah", "anyway ", "uh ", "um ")


def _is_filler_text(text: str, user_prompt_lower: str) -> bool:
    low = text.lower().strip()
    if not low:
        return True
    for phrase in FILLER_PHRASES:
        if phrase in low and phrase not in user_prompt_lower:
            if any(w in user_prompt_lower for w in ("sponsor", "subscribe", "intro", "mic check")):
                continue
            return True
    words = re.findall(r"[a-zA-Z0-9']+", low)
    meaningful = [w for w in words if w not in {"um", "uh", "ah", "er", "like", "yeah", "okay", "ok", "so"}]
    return len(meaningful) < 3


def _ends_complete_sentence(text: str) -> bool:
    stripped = text.strip()
    return stripped.endswith((".", "!", "?", '"', "'"))


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
        detected_category: VideoCategory,
        title: str = "",
    ) -> str:
        lines = [
            f"[{seg.start_sec:.2f} -> {seg.end_sec:.2f}] {seg.text}"
            for seg in transcript.segments
        ]
        transcript_block = "\n".join(lines)
        category_block = build_category_prompt_block(detected_category)
        title_line = f"Video title: {title}\n" if title else ""
        return (
            f"{title_line}"
            f"Total video duration: {transcript.duration_sec:.2f}s.\n"
            f"Target clip length: {min_clip_sec:.0f}s to {max_clip_sec:.0f}s.\n"
            f"Return at most {max_clips} varied, non-overlapping standalone clips.\n"
            f"Editor brief: {user_prompt}\n"
            f"{category_block}\n"
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
        title: str = "",
        video_category: Optional[str] = None,
    ) -> HighlightBatch:
        full_text = " ".join(s.text for s in transcript.segments)
        detected_cat, _conf, cat_reason = detect_video_category(
            full_text,
            title=title,
            user_prompt=user_prompt,
            requested_category=video_category,
        )
        payload = {
            "model": self.model,
            "stream": False,
            "format": HighlightBatch.model_json_schema(),
            "messages": [
                {"role": "system", "content": SENIOR_EDITOR_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": self._build_prompt(
                        transcript,
                        user_prompt,
                        min_clip_sec,
                        max_clip_sec,
                        max_clips,
                        detected_cat,
                        title=title,
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
                batch = HighlightBatch.model_validate(json.loads(content))
                final_cat = batch.detected_video_category or detected_cat.value
                try:
                    resolved_cat_enum = VideoCategory(final_cat)
                except ValueError:
                    resolved_cat_enum = detected_cat
                    final_cat = detected_cat.value

                valid: List[ClipCandidate] = []
                for c in batch.clips:
                    if not (
                        0.0 <= c.start_sec < transcript.duration_sec
                        and c.end_sec <= transcript.duration_sec + 0.25
                        and c.end_sec > c.start_sec
                    ):
                        continue
                    seg_txt = " ".join(
                        s.text
                        for s in transcript.segments
                        if s.end_sec >= c.start_sec and s.start_sec <= c.end_sec
                    )
                    eval_info = evaluate_text_for_category(seg_txt or c.reason, resolved_cat_enum)
                    data = c.model_dump()
                    data["video_category"] = data.get("video_category") or final_cat
                    if not data.get("viral_triggers"):
                        data["viral_triggers"] = eval_info["triggers"]
                    if resolved_cat_enum == VideoCategory.GAMING and not data.get("gaming_clip_type"):
                        data["gaming_clip_type"] = eval_info["gaming_clip_type"]
                    valid.append(ClipCandidate.model_validate(data))

                if not valid and self.allow_heuristic_fallback:
                    return self._heuristic_extract(
                        transcript,
                        user_prompt,
                        min_clip_sec,
                        max_clip_sec,
                        max_clips,
                        title=title,
                        video_category=video_category,
                    )
                return HighlightBatch(
                    detected_video_category=final_cat,
                    category_reason=batch.category_reason or cat_reason,
                    clips=valid[:max_clips],
                )
        except Exception as exc:  # noqa: BLE001
            if not self.allow_heuristic_fallback:
                raise RuntimeError(f"Ollama inference failed at {self.base_url}: {exc}") from exc
            return self._heuristic_extract(
                transcript,
                user_prompt,
                min_clip_sec,
                max_clip_sec,
                max_clips,
                title=title,
                video_category=video_category,
            )

    def _select_diverse_clips(
        self,
        candidates: List[ClipCandidate],
        max_clips: int,
        max_overlap_ratio: float = 0.40,
    ) -> List[ClipCandidate]:
        """Select non-overlapping clips while prioritizing variety across editorial dimensions and gaming focus types."""
        ranked = sorted(candidates, key=lambda c: c.composite_score, reverse=True)
        selected: List[ClipCandidate] = []

        def _overlaps_existing(cand: ClipCandidate) -> bool:
            cand_dur = max(0.001, cand.end_sec - cand.start_sec)
            for ex in selected:
                inter = max(0.0, min(cand.end_sec, ex.end_sec) - max(cand.start_sec, ex.start_sec))
                if inter / cand_dur >= max_overlap_ratio:
                    return True
                ex_dur = max(0.001, ex.end_sec - ex.start_sec)
                if inter / ex_dur >= max_overlap_ratio:
                    return True
            return False

        # Pass 1: pick top representative per editorial category first for variety
        buckets: Dict[ClipCategory, List[ClipCandidate]] = {
            ClipCategory.LESSON: [],
            ClipCategory.ENTERTAINMENT: [],
            ClipCategory.HOOK: [],
            ClipCategory.INSIGHT: [],
        }
        for c in ranked:
            buckets[c.category].append(c)

        made_progress = True
        while len(selected) < max_clips and made_progress:
            made_progress = False
            for cat in (
                ClipCategory.HOOK,
                ClipCategory.LESSON,
                ClipCategory.ENTERTAINMENT,
                ClipCategory.INSIGHT,
            ):
                if len(selected) >= max_clips:
                    break
                while buckets[cat]:
                    cand = buckets[cat].pop(0)
                    if not _overlaps_existing(cand):
                        selected.append(cand)
                        made_progress = True
                        break

        # Pass 2: fill any remaining slots by composite score
        for cand in ranked:
            if len(selected) >= max_clips:
                break
            if cand not in selected and not _overlaps_existing(cand):
                selected.append(cand)

        selected.sort(key=lambda c: c.start_sec)
        renumbered: List[ClipCandidate] = []
        for idx, c in enumerate(selected, start=1):
            data = c.model_dump()
            data["id"] = f"clip_{idx:02d}"
            renumbered.append(ClipCandidate.model_validate(data))
        return renumbered

    def _heuristic_extract(
        self,
        transcript: Transcript,
        user_prompt: str,
        min_clip_sec: float,
        max_clip_sec: float,
        max_clips: int,
        title: str = "",
        video_category: Optional[str] = None,
    ) -> HighlightBatch:
        """Offline multi-dimensional strategist scorer with category-specific rules & gaming sync."""
        segs = transcript.segments
        if not segs:
            return HighlightBatch(clips=[])

        full_text = " ".join(s.text for s in segs)
        detected_cat, _conf, cat_reason = detect_video_category(
            full_text,
            title=title,
            user_prompt=user_prompt,
            requested_category=video_category,
        )

        prompt_lower = user_prompt.lower()
        prompt_terms: Set[str] = {
            t.lower() for t in re.findall(r"[a-zA-Z0-9]{3,}", user_prompt)
        }
        effective_min = min(min_clip_sec, max(3.0, transcript.duration_sec * 0.25))
        candidates: List[ClipCandidate] = []

        for i in range(len(segs)):
            if _is_filler_text(segs[i].text, prompt_lower):
                continue

            window_segs = [segs[i]]
            j = i + 1
            while j < len(segs) and (segs[j].end_sec - segs[i].start_sec) <= max_clip_sec:
                if _is_filler_text(segs[j].text, prompt_lower):
                    if (window_segs[-1].end_sec - window_segs[0].start_sec) >= effective_min:
                        break
                window_segs.append(segs[j])
                cur_dur = window_segs[-1].end_sec - window_segs[0].start_sec
                if cur_dur >= min_clip_sec:
                    # For gaming, check if the very next segment provides the synchronized gameplay/reaction half!
                    if detected_cat == VideoCategory.GAMING and j + 1 < len(segs):
                        gap_to_next = segs[j + 1].start_sec - segs[j].end_sec
                        would_fit = (segs[j + 1].end_sec - segs[i].start_sec) <= max_clip_sec
                        if gap_to_next <= 3.0 and would_fit:
                            cur_g, cur_c = detect_gaming_focus_for_segment(" ".join(s.text for s in window_segs))
                            nxt_g, nxt_c = detect_gaming_focus_for_segment(segs[j + 1].text)
                            needs_reaction = cur_g > 0 and cur_c == 0 and nxt_c > 0
                            needs_gameplay = cur_c > 0 and cur_g == 0 and nxt_g > 0
                            if (needs_reaction or needs_gameplay) and not _is_filler_text(segs[j + 1].text, prompt_lower):
                                j += 1
                                continue

                    gap_next = (
                        segs[j + 1].start_sec - segs[j].end_sec
                        if j + 1 < len(segs)
                        else 1.0
                    )
                    if _ends_complete_sentence(segs[j].text) or gap_next >= 0.45:
                        break
                j += 1

            while len(window_segs) > 1 and _is_filler_text(window_segs[-1].text, prompt_lower):
                window_segs.pop()

            dur = window_segs[-1].end_sec - window_segs[0].start_sec
            if dur < effective_min:
                continue

            text = " ".join(s.text for s in window_segs).strip()
            if _is_filler_text(text, prompt_lower):
                continue

            tokens = {t.lower() for t in re.findall(r"[a-zA-Z0-9']+", text)}
            opener_text = window_segs[0].text.strip()
            opener_words = opener_text.split()

            hook_hits = len(tokens & HOOK_KEYWORDS)
            lesson_hits = len(tokens & LESSON_KEYWORDS)
            fun_hits = len(tokens & ENTERTAINMENT_KEYWORDS)
            prompt_hits = len(tokens & prompt_terms)

            cat_eval = evaluate_text_for_category(text, detected_cat)
            cat_boost = float(cat_eval["boost"])
            viral_triggers = list(cat_eval["triggers"])  # type: ignore[arg-type]
            gaming_clip_type = cat_eval["gaming_clip_type"]  # type: ignore[assignment]

            has_question = "?" in opener_text or "?" in text
            exclamations = text.count("!")
            has_number = bool(re.search(r"\b\d+", text))
            has_quotes = '"' in text or "'" in opener_text
            weak_opener = opener_text.lower().startswith(WEAK_OPENER_PREFIXES)
            complete_arc = _ends_complete_sentence(window_segs[-1].text)

            hook_score = (
                4.0
                + min(2.0, hook_hits * 0.7)
                + min(1.3, prompt_hits * 0.5)
                + cat_boost * 0.75
                + (1.1 if has_question else 0.0)
                + (0.6 if has_number else 0.0)
                + (0.5 if 4 <= len(opener_words) <= 15 else 0.0)
                - (1.0 if weak_opener else 0.0)
                - (0.6 if not complete_arc else 0.0)
            )
            lesson_score = (
                3.4
                + min(3.0, lesson_hits * 0.85)
                + min(1.3, prompt_hits * 0.45)
                + (cat_boost * 0.65 if detected_cat in (VideoCategory.BUSINESS, VideoCategory.EDUCATION, VideoCategory.MOTIVATION, VideoCategory.TECHNOLOGY, VideoCategory.RELATIONSHIPS, VideoCategory.POLITICS) else 0.0)
                + (0.8 if has_number else 0.0)
                + (0.7 if any(k in text.lower() for k in ("because", "instead", "avoid", "how to", "step")) else 0.0)
                - (0.5 if not complete_arc else 0.0)
            )
            entertainment_score = (
                3.3
                + min(3.2, fun_hits * 1.0)
                + min(1.4, exclamations * 0.65)
                + (cat_boost * 0.75 if detected_cat in (VideoCategory.COMEDY, VideoCategory.GAMING, VideoCategory.SPORTS) else 0.0)
                + (0.8 if has_quotes else 0.0)
                + min(0.7, prompt_hits * 0.35)
                - (0.4 if weak_opener else 0.0)
            )

            hook_score = round(max(1.0, min(10.0, hook_score)), 1)
            lesson_score = round(max(1.0, min(10.0, lesson_score)), 1)
            entertainment_score = round(max(1.0, min(10.0, entertainment_score)), 1)

            if entertainment_score >= lesson_score and entertainment_score >= hook_score and (fun_hits > 0 or detected_cat in (VideoCategory.COMEDY, VideoCategory.GAMING)):
                category = ClipCategory.ENTERTAINMENT
                pillar_label = "entertainment story/banter"
            elif lesson_score >= hook_score and (lesson_hits > 0 or detected_cat in (VideoCategory.BUSINESS, VideoCategory.EDUCATION, VideoCategory.MOTIVATION)):
                category = ClipCategory.LESSON
                pillar_label = "actionable lesson"
            elif has_question or hook_score >= 7.0:
                category = ClipCategory.HOOK
                pillar_label = "high-retention hook"
            else:
                category = ClipCategory.INSIGHT
                pillar_label = "key insight"

            first_sentence = re.split(r"[.!?]", opener_text)[0].strip()
            clip_title = first_sentence[:58] if first_sentence else f"Clip {len(candidates) + 1}"
            tags = sorted(
                list((tokens & (HOOK_KEYWORDS | LESSON_KEYWORDS | ENTERTAINMENT_KEYWORDS)) | (tokens & prompt_terms))
            )[:4]
            if detected_cat != VideoCategory.GENERAL and detected_cat.value not in tags:
                tags = [detected_cat.value, *tags][:4]
            elif category.value not in tags:
                tags = [category.value, *tags][:4]

            cat_label = CATEGORY_PROFILES[detected_cat].label
            trigger_note = f" [{', '.join(viral_triggers)}]" if viral_triggers else ""
            gaming_note = (
                f" ({gaming_clip_type.replace('_', ' ')})"
                if detected_cat == VideoCategory.GAMING and isinstance(gaming_clip_type, str)
                else ""
            )
            reason = (
                f"{cat_label}{gaming_note}: {pillar_label}{trigger_note}"
                + f" · Hook {hook_score}/10, Lesson {lesson_score}/10, Fun {entertainment_score}/10."
            )

            candidates.append(
                ClipCandidate(
                    id=f"cand_{i + 1:02d}",
                    title=clip_title,
                    category=category,
                    video_category=detected_cat.value,
                    viral_triggers=viral_triggers,
                    gaming_clip_type=str(gaming_clip_type) if gaming_clip_type else None,
                    start_sec=window_segs[0].start_sec,
                    end_sec=window_segs[-1].end_sec,
                    hook_score=hook_score,
                    lesson_score=lesson_score,
                    entertainment_score=entertainment_score,
                    reason=reason,
                    caption_hook=first_sentence[:48].upper() if first_sentence else clip_title.upper(),
                    tags=tags,
                )
            )

        if not candidates and segs:
            non_filler = [s for s in segs if not _is_filler_text(s.text, prompt_lower)] or segs
            full_clean = " ".join(s.text for s in non_filler).strip()
            cat_eval = evaluate_text_for_category(full_clean, detected_cat)
            candidates.append(
                ClipCandidate(
                    id="clip_01",
                    title=(full_clean[:58] or "Opening Segment"),
                    category=ClipCategory.INSIGHT,
                    video_category=detected_cat.value,
                    viral_triggers=list(cat_eval["triggers"]),  # type: ignore[arg-type]
                    gaming_clip_type=str(cat_eval["gaming_clip_type"]) if cat_eval["gaming_clip_type"] else None,
                    start_sec=non_filler[0].start_sec,
                    end_sec=non_filler[-1].end_sec,
                    hook_score=7.0,
                    lesson_score=6.5,
                    entertainment_score=5.5,
                    reason=f"{CATEGORY_PROFILES[detected_cat].label}: Full clean segment range selected.",
                    caption_hook=(full_clean[:48].upper() or "HIGHLIGHT"),
                    tags=[detected_cat.value if detected_cat != VideoCategory.GENERAL else "insight", "local"],
                )
            )

        diversified = self._select_diverse_clips(candidates, max_clips=max_clips)
        return HighlightBatch(
            detected_video_category=detected_cat.value,
            category_reason=cat_reason,
            clips=diversified,
        )
