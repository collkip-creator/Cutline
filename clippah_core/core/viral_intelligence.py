"""
Category-specific Viral Intelligence rules, domain auto-detection, and
gaming gameplay-vs-commentary synchronization logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from typing import Dict, List, Optional, Sequence, Tuple


class VideoCategory(str, Enum):
    BUSINESS = "business"
    COMEDY = "comedy"
    MOTIVATION = "motivation"
    POLITICS = "politics"
    SPORTS = "sports"
    RELATIONSHIPS = "relationships"
    TECHNOLOGY = "technology"
    EDUCATION = "education"
    GAMING = "gaming"
    GENERAL = "general"


class GamingClipType(str, Enum):
    GAMEPLAY_HIGHLIGHT = "gameplay_highlight"
    COMMENTARY_HIGHLIGHT = "commentary_highlight"
    SYNCED_GAMEPLAY_REACTION = "synced_gameplay_reaction"


@dataclass(frozen=True)
class CategoryProfile:
    category: VideoCategory
    label: str
    viral_trigger: str
    rules: Tuple[str, ...]
    strong_keywords: Tuple[str, ...]
    phrase_triggers: Tuple[Tuple[str, str], ...]  # (phrase/regex, readable trigger label)
    extra_instructions: str = ""


CATEGORY_PROFILES: Dict[VideoCategory, CategoryProfile] = {
    VideoCategory.BUSINESS: CategoryProfile(
        category=VideoCategory.BUSINESS,
        label="Business",
        viral_trigger="Financial clarity + counterintuitive insight + founder lessons",
        rules=(
            "Financial revelations (revenue numbers, margins, losses, exits, pricing secrets)",
            "Entrepreneurial mistakes and costly lessons learned from failure",
            "Actionable business strategies and unfair growth advantages",
            "Unpopular or contrarian business opinions",
            "Compelling founder and business success stories",
        ),
        strong_keywords=(
            "revenue", "profit", "margin", "startup", "founder", "business", "company",
            "investor", "valuation", "bankrupt", "bankruptcy", "debt", "million", "billion",
            "pricing", "client", "customers", "sales", "marketing", "hire", "hired", "fired",
            "equity", "bootstrapped", "scale", "scaling", "failed", "failure", "lesson",
            "entrepreneur", "ceo", "cashflow", "monetize", "roi", "conversion",
        ),
        phrase_triggers=(
            (r"\b(lost|burned|made|generated|earned)\s+\$?\d+", "Financial Revelation"),
            (r"\b(biggest|costly|worst)\s+mistake", "Entrepreneurial Mistake"),
            (r"\bunpopular opinion|\bmost founders\b|\beveryone gets wrong\b", "Unpopular Business Opinion"),
            (r"\bstrateg(y|ies)|\bplaybook\b|\bpricing\b|\bscale\b", "Business Strategy"),
            (r"\bfail(ed|ure)\b|\bbankrupt", "Lesson From Failure"),
            (r"\bsuccess story|\bfrom zero to\b|\bturned it around", "Success Story"),
        ),
    ),
    VideoCategory.COMEDY: CategoryProfile(
        category=VideoCategory.COMEDY,
        label="Comedy",
        viral_trigger="Surprise + relatable absurdity + punchline timing",
        rules=(
            "Sharp punchlines and comedic callbacks",
            "Unexpected humour and subverted expectations",
            "Funny spontaneous reactions and disbelief",
            "Sarcasm, deadpan delivery, and witty roasts",
            "Awkward moments and embarrassing confessions",
            "Humorous back-and-forth conversations and banter",
        ),
        strong_keywords=(
            "haha", "hahaha", "lol", "lmao", "funny", "hilarious", "joke", "punchline",
            "comedy", "comedian", "laugh", "laughing", "laughed", "sarcasm", "sarcastic",
            "awkward", "embarrassing", "roast", "banter", "ridiculous", "absurd", "prank",
            "kidding", "wait what", "unhinged",
        ),
        phrase_triggers=(
            (r"\bhaha|\blol|\blmao|\blaugh", "Funny Reaction"),
            (r"\bawkward|\bembarrass", "Awkward Moment"),
            (r"\bjoke|\bpunchline|\bjust kidding\b", "Punchline"),
            (r"\bsarcas|\byeah right\b|\btotally\b", "Sarcasm"),
            (r"\bwait what|\bno way you said\b|\bwhat just happened\b", "Unexpected Humour"),
        ),
    ),
    VideoCategory.MOTIVATION: CategoryProfile(
        category=VideoCategory.MOTIVATION,
        label="Motivation",
        viral_trigger="Emotional resonance + adversity overcome + memorable conviction",
        rules=(
            "Powerful life lessons earned through hardship",
            "Personal transformation and mindset breakthroughs",
            "Overcoming adversity, rock bottom, or self-doubt",
            "Inspirational stories of resilience and persistence",
            "Memorable, quotable statements delivered with conviction",
        ),
        strong_keywords=(
            "discipline", "mindset", "purpose", "dream", "dreams", "persevere", "resilience",
            "overcome", "adversity", "rock bottom", "transform", "transformation", "struggle",
            "sacrifice", "consistency", "fear", "courage", "believe", "grateful", "inspire",
            "inspirational", "potential", "quit", "never give up", "life lesson", "habit",
        ),
        phrase_triggers=(
            (r"\blife lesson|\bonce i realized\b|\bchanged my life\b", "Powerful Life Lesson"),
            (r"\brock bottom|\bhardest moment|\badversity|\bstruggl", "Adversity & Resilience"),
            (r"\btransform|\bbecame\b|\bchanged everything\b", "Personal Transformation"),
            (r"\bnever give up|\bkeep going|\bdo not quit|\bdon't quit\b", "Inspirational Statement"),
        ),
    ),
    VideoCategory.POLITICS: CategoryProfile(
        category=VideoCategory.POLITICS,
        label="Politics",
        viral_trigger="ideological clash + contradiction exposed + high-stakes accountability",
        rules=(
            "Sharp policy debates and direct confrontations",
            "Exposed contradictions between past and present statements",
            "Powerful, structured arguments under pressure",
            "Unexpected admissions or candid concessions",
            "Controversial public statements that spark strong debate",
        ),
        strong_keywords=(
            "election", "senate", "congress", "parliament", "president", "minister",
            "policy", "legislation", "bill", "vote", "voters", "tax", "taxes", "budget",
            "campaign", "debate", "government", "administration", "constitution", "law",
            "hypocrisy", "contradiction", "admit", "accountability", "public statement",
        ),
        phrase_triggers=(
            (r"\bcontradict|\bhypocri|\byou said\b|\bpreviously voted\b", "Contradiction Exposed"),
            (r"\bi admit|\btruth is\b|\blet's be honest\b", "Unexpected Admission"),
            (r"\bdebate|\bdisagree|\bpolicy\b|\bargument\b", "Policy Debate"),
            (r"\bcontrovers|\boutcry|\bpublic statement\b", "Controversial Statement"),
        ),
    ),
    VideoCategory.SPORTS: CategoryProfile(
        category=VideoCategory.SPORTS,
        label="Sports",
        viral_trigger="Peak athleticism + rivalry intensity + clutch unpredictability",
        rules=(
            "Remarkable athletic performances and highlight plays",
            "Heated rivalries and high-stakes matchups",
            "Raw emotional reactions from athletes, coaches, or fans",
            "Sharp tactical insights and film-room breakdowns",
            "Unexpected predictions, upsets, and bold hot takes",
        ),
        strong_keywords=(
            "championship", "playoffs", "finals", "tournament", "season", "coach",
            "athlete", "stadium", "goal", "touchdown", "dunk", "home run", "knockout",
            "quarterback", "striker", "midfield", "defense", "offense", "rivalry",
            "tactical", "formation", "upset", "mvp", "overtime", "buzzer", "medal",
        ),
        phrase_triggers=(
            (r"\brival|\bmatchup|\bderby\b", "Rivalry"),
            (r"\btactic|\bformation|\badjustment|\bstrategy\b", "Tactical Insight"),
            (r"\bpredict|\bupset|\bno one expected\b", "Unexpected Prediction"),
            (r"\bovertime|\bbuzzer|\bchampionship|\brecord\b", "Remarkable Performance"),
        ),
    ),
    VideoCategory.RELATIONSHIPS: CategoryProfile(
        category=VideoCategory.RELATIONSHIPS,
        label="Relationships",
        viral_trigger="Relatable tension + emotional vulnerability + shared human truth",
        rules=(
            "Deeply relatable everyday relationship experiences",
            "Candid disagreements and communication conflicts",
            "Memorable dating stories, red flags, and green flags",
            "Actionable relationship advice and boundary setting",
            "Honest emotional revelations and vulnerability",
        ),
        strong_keywords=(
            "relationship", "relationships", "dating", "partner", "marriage", "married",
            "husband", "wife", "boyfriend", "girlfriend", "breakup", "divorce", "trust",
            "jealous", "boundaries", "communication", "love", "heartbreak", "red flag",
            "conflict", "apology", "feelings", "affection", "loyalty",
        ),
        phrase_triggers=(
            (r"\bred flag|\bgreen flag|\bdating\b", "Dating Experience"),
            (r"\bboundar|\bcommunicat|\bnever tolerate\b", "Relationship Advice"),
            (r"\bargument|\bdisagree|\bfight\b", "Disagreement"),
            (r"\brelat|\bwe all do\b|\bevery couple\b", "Relatable Experience"),
            (r"\bhurt|\bconfess|\btruth about my\b|\bemotional\b", "Emotional Revelation"),
        ),
    ),
    VideoCategory.TECHNOLOGY: CategoryProfile(
        category=VideoCategory.TECHNOLOGY,
        label="Technology",
        viral_trigger="Wow-factor demonstration + myth-busting + future-shaping utility",
        rules=(
            "Surprising live demonstrations and benchmark breakthroughs",
            "Bold, well-reasoned future technology predictions",
            "Common tech misconceptions debunked clearly",
            "New technological discoveries, tools, or architecture shifts",
            "Concise, genuinely useful explanations of complex tech",
        ),
        strong_keywords=(
            "ai", "llm", "software", "hardware", "gpu", "cpu", "chip", "quantum",
            "robot", "robotics", "algorithm", "model", "neural", "code", "developer",
            "cloud", "local", "latency", "benchmark", "automation", "device", "app",
            "cybersecurity", "encryption", "battery", "drone", "vr", "architecture",
        ),
        phrase_triggers=(
            (r"\bdemo|\blook at this|\bwatch what happens|\bbenchmark", "Surprising Demonstration"),
            (r"\bfuture|\bin 5 years|\bin five years|\bnext decade|\bwill replace", "Future Prediction"),
            (r"\bmisconception|\bmyth|\bactually works\b", "Misconception Debunked"),
            (r"\bdiscovery|\bbreakthrough|\bjust released|\bannounced\b", "Tech Discovery"),
            (r"\bhow it works|\bunder the hood|\bin simple terms\b", "Useful Explanation"),
        ),
    ),
    VideoCategory.EDUCATION: CategoryProfile(
        category=VideoCategory.EDUCATION,
        label="Education",
        viral_trigger="Instant clarity + curiosity gap closed + immediate learning benefit",
        rules=(
            "Simplified explanations that make hard concepts click fast",
            "Surprising, memorable facts viewers want to share",
            "Common myths and misconceptions corrected with clarity",
            "Practical step-by-step demonstrations",
            "Knowledge delivering an immediate, usable learning benefit",
        ),
        strong_keywords=(
            "learn", "explain", "explained", "explanation", "lesson", "study", "science",
            "history", "math", "physics", "biology", "psychology", "fact", "facts",
            "formula", "tutorial", "guide", "method", "technique", "concept", "theory",
            "misconception", "experiment", "proof", "teacher", "student", "remember",
        ),
        phrase_triggers=(
            (r"\bhere's why|\bthink of it like|\bin simple terms|\bsimplified\b", "Simplified Explanation"),
            (r"\bfun fact|\bdid you know|\bmost people don't know\b", "Interesting Fact"),
            (r"\bmisconception|\bactually false|\bmyth\b", "Misconception Corrected"),
            (r"\bstep by step|\bhow to\b|\btry this\b", "Practical Demonstration"),
        ),
    ),
    VideoCategory.GAMING: CategoryProfile(
        category=VideoCategory.GAMING,
        label="Gaming",
        viral_trigger="Excitement + skill + humour + surprise + competition",
        rules=(
            "Incredible gameplay moments and extraordinary skills",
            "Unexpected victories and dramatic comebacks",
            "Funny fails, embarrassing mistakes and unexpected mishaps",
            "Intense player reactions, rage moments and celebrations",
            "Epic battles, clutch plays and last-second wins",
            "Unexpected plot twists and shocking in-game discoveries",
            "Impressive strategies, tricks, shortcuts and hidden game mechanics",
            "Competitive rivalries, trash talk and heated exchanges",
            "Glitches, bugs and hilarious game physics",
            "Memorable multiplayer interactions and unexpected encounters",
            "Speedruns, record-breaking performances and world-first achievements",
            "Surprising gaming secrets, Easter eggs and hidden content",
            "Emotional moments involving favourite characters or storylines",
            "Unusual challenges and creative ways of completing games",
        ),
        strong_keywords=(
            "clutch", "headshot", "ace", "kill", "boss", "respawn", "spawn", "nerf", "buff",
            "speedrun", "world record", "world first", "glitch", "bug", "physics", "hitbox",
            "easter egg", "secret", "loot", "raid", "lobby", "ranked", "esports", "fps",
            "hp", "health", "ult", "ultimate", "combo", "parry", "dodge", "comeback",
            "rage", "gg", "noob", "trash talk", "teammate", "multiplayer", "quest", "npc",
            "cutscene", "campaign", "minecraft", "valorant", "fortnite", "elden ring",
            "cod", "warzone", "league", "apex", "csgo", "cs2", "zelda", "gta",
        ),
        phrase_triggers=(
            (r"\bclutch|\b1v\d|\blast second|\bcomeback|\bzero hp|\b1 hp", "Clutch Play / Comeback"),
            (r"\bfail|\bembarrass|\bthrown|\bmishap|\bfell off|\bblow myself up", "Funny Fail / Mishap"),
            (r"\bno way|\bohh*!|\blet's go|\bwhat the|\brage|\bscream|\bcelebrat", "Intense Reaction / Celebration"),
            (r"\bboss\b|\bepic\b|\bfinal phase|\bfight\b", "Epic Battle"),
            (r"\bplot twist|\bwhat is that|\bdiscover", "Plot Twist / Discovery"),
            (r"\btrick|\bshortcut|\bmechanic|\bstrat(egy)?|\bskip\b", "Hidden Mechanic / Strategy"),
            (r"\btrash talk|\brival|\b1v1\b|\bdiff\b", "Competitive Rivalry"),
            (r"\bglitch|\bbug\b|\bphysics|\bflying\b|\bclipped through", "Hilarious Glitch / Physics"),
            (r"\bspeedrun|\bworld record|\bworld first|\bpb\b", "Speedrun / Record"),
            (r"\beaster egg|\bhidden\b|\bsecret room|\bsecret ending", "Secret / Easter Egg"),
            (r"\bchallenge|\bno hit|\bpacifist|\bwithout taking damage", "Creative Challenge"),
        ),
        extra_instructions=(
            "Additional Gaming Detection Instruction: Explicitly distinguish between "
            "`gameplay_highlight` (what happens inside the game: skill plays, clutch wins, bosses, glitches, secrets, speedruns, storyline twists) "
            "and `commentary_highlight` (the player's voice, jokes, rage, trash talk, narration, or multiplayer banter). "
            "Wherever important in-game events happen alongside or right before the player's vocal reaction/commentary, "
            "synchronize both into a single clip (`synced_gameplay_reaction`) covering both the gameplay setup/payoff AND the player reaction."
        ),
    ),
    VideoCategory.GENERAL: CategoryProfile(
        category=VideoCategory.GENERAL,
        label="General",
        viral_trigger="Curiosity hook + clear payoff + emotional or practical impact",
        rules=(
            "Strong opening hooks that create an immediate curiosity gap",
            "Clear standalone payoffs, lessons, or memorable stories",
            "High-energy reactions, surprises, or sharp insights",
        ),
        strong_keywords=(),
        phrase_triggers=(),
    ),
}


GAMING_GAMEPLAY_CUES = (
    "clutch", "headshot", "ace", "kill", "killed", "boss", "damage", "hp", "ultimate",
    "ult", "parry", "combo", "dodge", "comeback", "win", "won", "victory", "last second",
    "speedrun", "record", "world first", "glitch", "bug", "physics", "shortcut", "skip",
    "easter egg", "secret", "loot", "phase", "cutscene", "mission", "level", "quest",
    "1v", "2v", "defuse", "snipe", "wipe", "squad",
)

GAMING_COMMENTARY_CUES = (
    "no way", "what", "oh my god", "omg", "bro", "dude", "wait", "laugh", "haha", "lol",
    "lmao", "scream", "rage", "let's go", "lets go", "insane", "crazy", "trash", "chat",
    "teammate", "opponent", "voice", "mic", "yelling", "shocked", "speechless", "look at",
    "i told you", "watch this", "clip that", "are you kidding",
)


def normalize_requested_category(raw: Optional[str]) -> Optional[VideoCategory]:
    if not raw:
        return None
    cleaned = str(raw).strip().lower()
    if not cleaned or cleaned in ("auto", "detect", "auto-detect"):
        return None
    for cat in VideoCategory:
        if cat.value == cleaned:
            return cat
    return None


def detect_video_category(
    transcript_text: str,
    title: str = "",
    user_prompt: str = "",
    requested_category: Optional[str] = None,
) -> Tuple[VideoCategory, float, str]:
    """Identify the primary video category from title, user brief, and transcript."""
    explicit = normalize_requested_category(requested_category)
    if explicit is not None and explicit != VideoCategory.GENERAL:
        return explicit, 1.0, f"Selected category: {CATEGORY_PROFILES[explicit].label}"

    title_low = (title or "").lower()
    prompt_low = (user_prompt or "").lower()
    body_low = (transcript_text or "").lower()
    combined = f"{title_low}\n{prompt_low}\n{body_low}"

    scores: Dict[VideoCategory, float] = {}
    matched_terms: Dict[VideoCategory, List[str]] = {}

    for cat, profile in CATEGORY_PROFILES.items():
        if cat == VideoCategory.GENERAL:
            continue
        score = 0.0
        hits: List[str] = []
        # Direct mention of category name in title/prompt is a strong signal
        if cat.value in title_low or cat.value in prompt_low:
            score += 4.5
            hits.append(cat.value)

        for kw in profile.strong_keywords:
            pattern = r"\b" + re.escape(kw) + r"\b"
            in_title = bool(re.search(pattern, title_low))
            in_body = len(re.findall(pattern, body_low))
            if in_title:
                score += 2.6
                hits.append(kw)
            if in_body:
                score += min(4.5, in_body * 1.15)
                if kw not in hits:
                    hits.append(kw)

        for rx, _label in profile.phrase_triggers:
            matches = re.findall(rx, combined)
            if matches:
                score += min(4.0, len(matches) * 1.4)

        scores[cat] = score
        matched_terms[cat] = hits

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    if not ranked or ranked[0][1] < 2.0:
        return (
            VideoCategory.GENERAL,
            0.35,
            "Auto-detected General short-form profile (no single vertical dominated transcript cues)",
        )

    best_cat, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = round(min(0.99, max(0.45, best_score / max(best_score + second_score * 0.6, 6.0))), 2)
    sample_hits = ", ".join(matched_terms[best_cat][:4])
    reason = (
        f"Auto-detected {CATEGORY_PROFILES[best_cat].label} ({sample_hits})"
        if sample_hits
        else f"Auto-detected {CATEGORY_PROFILES[best_cat].label}"
    )
    return best_cat, confidence, reason


def evaluate_text_for_category(
    text: str,
    video_category: VideoCategory,
) -> Dict[str, object]:
    """Score how strongly a transcript window fires category-specific viral rules."""
    low = (text or "").lower()
    profile = CATEGORY_PROFILES.get(video_category, CATEGORY_PROFILES[VideoCategory.GENERAL])

    triggers: List[str] = []
    for rx, label in profile.phrase_triggers:
        if re.search(rx, low) and label not in triggers:
            triggers.append(label)

    kw_hits = 0
    for kw in profile.strong_keywords:
        if re.search(r"\b" + re.escape(kw) + r"\b", low):
            kw_hits += 1

    boost = min(2.4, len(triggers) * 0.65 + min(3, kw_hits) * 0.3)

    gaming_clip_type: Optional[str] = None
    gameplay_hits = 0
    commentary_hits = 0
    if video_category == VideoCategory.GAMING:
        gameplay_hits = sum(1 for cue in GAMING_GAMEPLAY_CUES if cue in low)
        commentary_hits = sum(
            1 for cue in GAMING_COMMENTARY_CUES if cue in low
        ) + (1 if "!" in text or "?" in text else 0)
        if gameplay_hits > 0 and commentary_hits > 0:
            gaming_clip_type = GamingClipType.SYNCED_GAMEPLAY_REACTION.value
            if "Synced Gameplay + Reaction" not in triggers:
                triggers.append("Synced Gameplay + Reaction")
            boost += 0.7
        elif gameplay_hits >= commentary_hits and gameplay_hits > 0:
            gaming_clip_type = GamingClipType.GAMEPLAY_HIGHLIGHT.value
        elif commentary_hits > 0:
            gaming_clip_type = GamingClipType.COMMENTARY_HIGHLIGHT.value
        else:
            gaming_clip_type = GamingClipType.GAMEPLAY_HIGHLIGHT.value

    return {
        "triggers": triggers[:4],
        "boost": round(boost, 2),
        "kw_hits": kw_hits,
        "gaming_clip_type": gaming_clip_type,
        "gameplay_hits": gameplay_hits,
        "commentary_hits": commentary_hits,
    }


def detect_gaming_focus_for_segment(text: str) -> Tuple[int, int]:
    low = (text or "").lower()
    gameplay_hits = sum(1 for cue in GAMING_GAMEPLAY_CUES if cue in low)
    commentary_hits = sum(1 for cue in GAMING_COMMENTARY_CUES if cue in low) + (
        1 if ("!" in text or "?" in text) else 0
    )
    return gameplay_hits, commentary_hits


def build_category_prompt_block(video_category: VideoCategory) -> str:
    """Format detailed category-specific Viral Intelligence guidelines for LLM prompts."""
    if video_category == VideoCategory.GENERAL:
        parts = [
            "### Automatic Category-Specific Viral Intelligence",
            "First identify the video category from this list: business, comedy, motivation, politics, sports, relationships, technology, education, gaming, or general.",
            "Then apply the matching domain rules:",
        ]
        for cat in (
            VideoCategory.BUSINESS,
            VideoCategory.COMEDY,
            VideoCategory.MOTIVATION,
            VideoCategory.POLITICS,
            VideoCategory.SPORTS,
            VideoCategory.RELATIONSHIPS,
            VideoCategory.TECHNOLOGY,
            VideoCategory.EDUCATION,
            VideoCategory.GAMING,
        ):
            prof = CATEGORY_PROFILES[cat]
            parts.append(f"- {prof.label.upper()}: {', '.join(prof.rules)}. Viral trigger: {prof.viral_trigger}.")
        parts.append(CATEGORY_PROFILES[VideoCategory.GAMING].extra_instructions)
        return "\n".join(parts)

    prof = CATEGORY_PROFILES[video_category]
    lines = [
        f"### Category-Specific Viral Intelligence ({prof.label.upper()})",
        f"Viral Trigger Formula: {prof.viral_trigger}",
        "Prioritize segments matching these category-specific detection rules:",
        *[f"- {r}" for r in prof.rules],
    ]
    if prof.extra_instructions:
        lines.append(prof.extra_instructions)
    return "\n".join(lines)
