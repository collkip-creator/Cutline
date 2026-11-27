export type VideoCategory =
  | 'business'
  | 'comedy'
  | 'motivation'
  | 'politics'
  | 'sports'
  | 'relationships'
  | 'technology'
  | 'education'
  | 'gaming'
  | 'general';

export type VideoCategoryOption = 'auto' | VideoCategory;

export type GamingClipType =
  | 'gameplay_highlight'
  | 'commentary_highlight'
  | 'synced_gameplay_reaction';

export interface CategoryProfile {
  category: VideoCategory;
  label: string;
  viralTrigger: string;
  rules: string[];
  strongKeywords: string[];
  phraseTriggers: Array<{ regex: RegExp; label: string }>;
  extraInstructions?: string;
}

export const VIDEO_CATEGORIES: VideoCategory[] = [
  'business',
  'comedy',
  'motivation',
  'politics',
  'sports',
  'relationships',
  'technology',
  'education',
  'gaming',
  'general',
];

export const CATEGORY_PROFILES: Record<VideoCategory, CategoryProfile> = {
  business: {
    category: 'business',
    label: 'Business',
    viralTrigger: 'Financial clarity + counterintuitive insight + founder lessons',
    rules: [
      'Financial revelations (revenue numbers, margins, losses, exits, pricing secrets)',
      'Entrepreneurial mistakes and costly lessons learned from failure',
      'Business strategies, growth playbooks, and unfair operational advantages',
      'Lessons from failure and turnaround decisions',
      'Unpopular business opinions that challenge conventional wisdom',
      'Compelling founder and business success stories',
    ],
    strongKeywords: [
      'revenue', 'profit', 'margin', 'startup', 'founder', 'business', 'company',
      'investor', 'valuation', 'bankrupt', 'bankruptcy', 'debt', 'million', 'billion',
      'pricing', 'client', 'customers', 'sales', 'marketing', 'hire', 'hired', 'fired',
      'equity', 'bootstrapped', 'scale', 'scaling', 'failed', 'failure', 'lesson',
      'entrepreneur', 'ceo', 'cashflow', 'monetize', 'roi', 'conversion',
    ],
    phraseTriggers: [
      { regex: /\b(lost|burned|made|generated|earned)\s+\$?\d+/i, label: 'Financial Revelation' },
      { regex: /\b(biggest|costly|worst)\s+mistake/i, label: 'Entrepreneurial Mistake' },
      { regex: /\bunpopular opinion|\bmost founders\b|\beveryone gets wrong\b/i, label: 'Unpopular Business Opinion' },
      { regex: /\bstrateg(y|ies)|\bplaybook\b|\bpricing\b|\bscale\b/i, label: 'Business Strategy' },
      { regex: /\bfail(ed|ure)\b|\bbankrupt/i, label: 'Lesson From Failure' },
      { regex: /\bsuccess story|\bfrom zero to\b|\bturned it around/i, label: 'Success Story' },
    ],
  },
  comedy: {
    category: 'comedy',
    label: 'Comedy',
    viralTrigger: 'Surprise + relatable absurdity + punchline timing',
    rules: [
      'Sharp punchlines and comedic callbacks',
      'Unexpected humour and subverted expectations',
      'Funny reactions and spontaneous disbelief',
      'Sarcasm, deadpan delivery, and witty roasts',
      'Awkward moments and embarrassing confessions',
      'Humorous conversations and hilarious banter',
    ],
    strongKeywords: [
      'haha', 'hahaha', 'lol', 'lmao', 'funny', 'hilarious', 'joke', 'punchline',
      'comedy', 'comedian', 'laugh', 'laughing', 'laughed', 'sarcasm', 'sarcastic',
      'awkward', 'embarrassing', 'roast', 'banter', 'ridiculous', 'absurd', 'prank',
      'kidding', 'unhinged',
    ],
    phraseTriggers: [
      { regex: /\bhaha|\blol|\blmao|\blaugh/i, label: 'Funny Reaction' },
      { regex: /\bawkward|\bembarrass/i, label: 'Awkward Moment' },
      { regex: /\bjoke|\bpunchline|\bjust kidding\b/i, label: 'Punchline' },
      { regex: /\bsarcas|\byeah right\b/i, label: 'Sarcasm' },
      { regex: /\bwait what|\bno way you said\b|\bwhat just happened\b/i, label: 'Unexpected Humour' },
    ],
  },
  motivation: {
    category: 'motivation',
    label: 'Motivation',
    viralTrigger: 'Emotional resonance + adversity overcome + memorable conviction',
    rules: [
      'Powerful life lessons earned through experience',
      'Personal transformation and mindset breakthroughs',
      'Overcoming adversity, rock bottom, or self-doubt',
      'Inspirational stories of resilience and persistence',
      'Memorable statements delivered with conviction',
    ],
    strongKeywords: [
      'discipline', 'mindset', 'purpose', 'dream', 'dreams', 'persevere', 'resilience',
      'overcome', 'adversity', 'transform', 'transformation', 'struggle', 'sacrifice',
      'consistency', 'fear', 'courage', 'believe', 'grateful', 'inspire', 'inspirational',
      'potential', 'quit', 'habit',
    ],
    phraseTriggers: [
      { regex: /\blife lesson|\bonce i realized\b|\bchanged my life\b/i, label: 'Powerful Life Lesson' },
      { regex: /\brock bottom|\bhardest moment|\badversity|\bstruggl/i, label: 'Adversity & Resilience' },
      { regex: /\btransform|\bchanged everything\b/i, label: 'Personal Transformation' },
      { regex: /\bnever give up|\bkeep going|\bdon't quit\b/i, label: 'Memorable Statement' },
    ],
  },
  politics: {
    category: 'politics',
    label: 'Politics',
    viralTrigger: 'Ideological clash + contradiction exposed + public accountability',
    rules: [
      'Direct debates and sharp policy confrontations',
      'Contradictions exposed between past and current stances',
      'Powerful, structured arguments under questioning',
      'Unexpected admissions or candid concessions',
      'Controversial public statements that spark debate',
    ],
    strongKeywords: [
      'election', 'senate', 'congress', 'parliament', 'president', 'minister',
      'policy', 'legislation', 'bill', 'vote', 'voters', 'tax', 'taxes', 'budget',
      'campaign', 'debate', 'government', 'administration', 'constitution', 'law',
      'hypocrisy', 'contradiction', 'admit', 'accountability',
    ],
    phraseTriggers: [
      { regex: /\bcontradict|\bhypocri|\byou said\b|\bpreviously voted\b/i, label: 'Contradiction Exposed' },
      { regex: /\bi admit|\btruth is\b|\blet's be honest\b/i, label: 'Unexpected Admission' },
      { regex: /\bdebate|\bdisagree|\bpolicy\b|\bargument\b/i, label: 'Debate / Argument' },
      { regex: /\bcontrovers|\boutcry|\bpublic statement\b/i, label: 'Controversial Statement' },
    ],
  },
  sports: {
    category: 'sports',
    label: 'Sports',
    viralTrigger: 'Peak athleticism + rivalry intensity + clutch unpredictability',
    rules: [
      'Remarkable performances and highlight plays',
      'Competitive rivalry and heated matchups',
      'Emotional reactions from players, coaches, or analysts',
      'Tactical insights and strategic breakdowns',
      'Unexpected predictions, upsets, and bold calls',
    ],
    strongKeywords: [
      'championship', 'playoffs', 'finals', 'tournament', 'season', 'coach',
      'athlete', 'stadium', 'goal', 'touchdown', 'dunk', 'knockout', 'quarterback',
      'striker', 'midfield', 'defense', 'offense', 'rivalry', 'tactical', 'formation',
      'upset', 'mvp', 'overtime', 'buzzer', 'medal',
    ],
    phraseTriggers: [
      { regex: /\brival|\bmatchup|\bderby\b/i, label: 'Rivalry' },
      { regex: /\btactic|\bformation|\badjustment|\bstrategy\b/i, label: 'Tactical Insight' },
      { regex: /\bpredict|\bupset|\bno one expected\b/i, label: 'Unexpected Prediction' },
      { regex: /\bovertime|\bbuzzer|\bchampionship|\brecord\b/i, label: 'Remarkable Performance' },
    ],
  },
  relationships: {
    category: 'relationships',
    label: 'Relationships',
    viralTrigger: 'Relatable tension + emotional vulnerability + dating truth',
    rules: [
      'Relatable experiences couples and friends recognize instantly',
      'Disagreements and communication breakthroughs',
      'Candid dating experiences, red flags, and green flags',
      'Actionable relationship advice and boundaries',
      'Emotional revelations and honest vulnerability',
    ],
    strongKeywords: [
      'relationship', 'relationships', 'dating', 'partner', 'marriage', 'married',
      'husband', 'wife', 'boyfriend', 'girlfriend', 'breakup', 'divorce', 'trust',
      'jealous', 'boundaries', 'communication', 'love', 'heartbreak', 'conflict',
      'apology', 'feelings', 'affection', 'loyalty',
    ],
    phraseTriggers: [
      { regex: /\bred flag|\bgreen flag|\bdating\b/i, label: 'Dating Experience' },
      { regex: /\bboundar|\bcommunicat|\bnever tolerate\b/i, label: 'Relationship Advice' },
      { regex: /\bargument|\bdisagree|\bfight\b/i, label: 'Disagreement' },
      { regex: /\brelat|\bevery couple\b/i, label: 'Relatable Experience' },
      { regex: /\bhurt|\bconfess|\btruth about my\b|\bemotional\b/i, label: 'Emotional Revelation' },
    ],
  },
  technology: {
    category: 'technology',
    label: 'Technology',
    viralTrigger: 'Wow-factor demo + myth-busting + future-shaping utility',
    rules: [
      'Surprising demonstrations and live benchmarks',
      'Bold future predictions about AI, hardware, or software',
      'Common tech misconceptions debunked clearly',
      'Technological discoveries and architecture breakthroughs',
      'Useful, crystal-clear technical explanations',
    ],
    strongKeywords: [
      'ai', 'llm', 'software', 'hardware', 'gpu', 'cpu', 'chip', 'quantum',
      'robot', 'robotics', 'algorithm', 'model', 'neural', 'code', 'developer',
      'cloud', 'local', 'latency', 'benchmark', 'automation', 'device', 'app',
      'cybersecurity', 'encryption', 'battery', 'drone', 'architecture',
    ],
    phraseTriggers: [
      { regex: /\bdemo|\blook at this|\bwatch what happens|\bbenchmark/i, label: 'Surprising Demo' },
      { regex: /\bfuture|\bin 5 years|\bin five years|\bwill replace/i, label: 'Future Prediction' },
      { regex: /\bmisconception|\bmyth|\bactually works\b/i, label: 'Misconception' },
      { regex: /\bdiscovery|\bbreakthrough|\bjust released|\bannounced\b/i, label: 'Tech Discovery' },
      { regex: /\bhow it works|\bunder the hood|\bin simple terms\b/i, label: 'Useful Explanation' },
    ],
  },
  education: {
    category: 'education',
    label: 'Education',
    viralTrigger: 'Instant clarity + curiosity gap closed + immediate learning benefit',
    rules: [
      'Simplified explanations of complex ideas',
      'Interesting facts viewers want to share immediately',
      'Misconceptions corrected with memorable clarity',
      'Practical demonstrations viewers can replicate',
      'Knowledge that creates an immediate learning benefit',
    ],
    strongKeywords: [
      'learn', 'explain', 'explained', 'explanation', 'lesson', 'study', 'science',
      'history', 'math', 'physics', 'biology', 'psychology', 'fact', 'facts',
      'formula', 'tutorial', 'guide', 'method', 'technique', 'concept', 'theory',
      'misconception', 'experiment', 'proof', 'teacher', 'student', 'remember',
    ],
    phraseTriggers: [
      { regex: /\bhere's why|\bthink of it like|\bin simple terms|\bsimplified\b/i, label: 'Simplified Explanation' },
      { regex: /\bfun fact|\bdid you know|\bmost people don't know\b/i, label: 'Interesting Fact' },
      { regex: /\bmisconception|\bactually false|\bmyth\b/i, label: 'Misconception' },
      { regex: /\bstep by step|\bhow to\b|\btry this\b/i, label: 'Practical Demonstration' },
    ],
  },
  gaming: {
    category: 'gaming',
    label: 'Gaming',
    viralTrigger: 'Excitement + skill + humour + surprise + competition',
    rules: [
      'Incredible gameplay moments and extraordinary skills',
      'Unexpected victories and dramatic comebacks',
      'Funny fails, embarrassing mistakes and unexpected mishaps',
      'Intense player reactions, rage moments and celebrations',
      'Epic battles, clutch plays and last-second wins',
      'Unexpected plot twists and shocking in-game discoveries',
      'Impressive strategies, tricks, shortcuts and hidden game mechanics',
      'Competitive rivalries, trash talk and heated exchanges',
      'Glitches, bugs and hilarious game physics',
      'Memorable multiplayer interactions and unexpected encounters',
      'Speedruns, record-breaking performances and world-first achievements',
      'Surprising gaming secrets, Easter eggs and hidden content',
      'Emotional moments involving favourite characters or storylines',
      'Unusual challenges and creative ways of completing games',
    ],
    strongKeywords: [
      'clutch', 'headshot', 'ace', 'kill', 'boss', 'respawn', 'spawn', 'nerf', 'buff',
      'speedrun', 'world record', 'world first', 'glitch', 'bug', 'physics', 'hitbox',
      'easter egg', 'secret', 'loot', 'raid', 'lobby', 'ranked', 'esports', 'fps',
      'hp', 'health', 'ult', 'ultimate', 'combo', 'parry', 'dodge', 'comeback',
      'rage', 'gg', 'noob', 'trash talk', 'teammate', 'multiplayer', 'quest', 'npc',
      'cutscene', 'campaign', 'minecraft', 'valorant', 'fortnite', 'elden ring',
      'warzone', 'league', 'apex', 'cs2', 'zelda', 'gta',
    ],
    phraseTriggers: [
      { regex: /\bclutch|\b1v\d|\blast second|\bcomeback|\bzero hp|\b1 hp/i, label: 'Clutch Play / Comeback' },
      { regex: /\bfail|\bembarrass|\bmishap|\bfell off/i, label: 'Funny Fail / Mishap' },
      { regex: /\bno way|\bohh*!|\blet's go|\brage|\bscream|\bcelebrat/i, label: 'Intense Reaction / Celebration' },
      { regex: /\bboss\b|\bepic\b|\bfinal phase/i, label: 'Epic Battle' },
      { regex: /\bplot twist|\bwhat is that|\bdiscover/i, label: 'Plot Twist / Discovery' },
      { regex: /\btrick|\bshortcut|\bmechanic|\bstrat(egy)?|\bskip\b/i, label: 'Hidden Mechanic / Strategy' },
      { regex: /\btrash talk|\brival|\b1v1\b/i, label: 'Competitive Rivalry' },
      { regex: /\bglitch|\bbug\b|\bphysics|\bclipped through/i, label: 'Hilarious Glitch / Physics' },
      { regex: /\bspeedrun|\bworld record|\bworld first/i, label: 'Speedrun / Record' },
      { regex: /\beaster egg|\bhidden\b|\bsecret room|\bsecret ending/i, label: 'Secret / Easter Egg' },
      { regex: /\bchallenge|\bno hit|\bpacifist/i, label: 'Creative Challenge' },
    ],
    extraInstructions:
      'Additional AI detection instruction: Distinguish between `gameplay_highlight` (what happens inside the game: extraordinary skills, clutch wins, bosses, glitches, speedruns, secrets, plot twists) and `commentary_highlight` (the player\'s voice, reactions, rage, humour, trash talk, or commentary). Where possible, synchronize important gameplay events with the player\'s reactions into a `synced_gameplay_reaction` clip so both the gameplay event and the player\'s reaction land together cleanly.',
  },
  general: {
    category: 'general',
    label: 'General',
    viralTrigger: 'Curiosity hook + clear payoff + emotional or practical impact',
    rules: [
      'Bold opening hooks that spark immediate curiosity',
      'Clear standalone insights, practical lessons, or memorable stories',
      'High-energy reactions, surprises, or vivid demonstrations',
    ],
    strongKeywords: [],
    phraseTriggers: [],
  },
};

const GAMING_GAMEPLAY_CUES = [
  'clutch', 'headshot', 'ace', 'kill', 'killed', 'boss', 'damage', 'hp', 'ultimate',
  'ult', 'parry', 'combo', 'dodge', 'comeback', 'win', 'won', 'victory', 'last second',
  'speedrun', 'record', 'world first', 'glitch', 'bug', 'physics', 'shortcut', 'skip',
  'easter egg', 'secret', 'loot', 'phase', 'cutscene', 'mission', 'level', 'quest',
  '1v', '2v', 'defuse', 'snipe', 'wipe', 'squad',
];

const GAMING_COMMENTARY_CUES = [
  'no way', 'what', 'oh my god', 'omg', 'bro', 'dude', 'wait', 'laugh', 'haha', 'lol',
  'lmao', 'scream', 'rage', "let's go", 'lets go', 'insane', 'crazy', 'trash', 'chat',
  'teammate', 'opponent', 'voice', 'mic', 'yelling', 'shocked', 'speechless', 'look at',
  'i told you', 'watch this', 'clip that', 'are you kidding',
];

export function normalizeVideoCategory(raw?: string | null): VideoCategory | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().toLowerCase();
  if (!cleaned || cleaned === 'auto' || cleaned === 'detect' || cleaned === 'auto-detect') {
    return null;
  }
  return (VIDEO_CATEGORIES as string[]).includes(cleaned) ? (cleaned as VideoCategory) : null;
}

export function detectVideoCategory(params: {
  transcriptText: string;
  title?: string;
  prompt?: string;
  requestedCategory?: string | null;
}): { category: VideoCategory; confidence: number; reason: string } {
  const explicit = normalizeVideoCategory(params.requestedCategory);
  if (explicit && explicit !== 'general') {
    return {
      category: explicit,
      confidence: 1,
      reason: `Selected category: ${CATEGORY_PROFILES[explicit].label}`,
    };
  }

  const titleLow = (params.title || '').toLowerCase();
  const promptLow = (params.prompt || '').toLowerCase();
  const bodyLow = (params.transcriptText || '').toLowerCase();
  const combined = `${titleLow}\n${promptLow}\n${bodyLow}`;

  const ranked: Array<{ category: VideoCategory; score: number; hits: string[] }> = [];

  for (const cat of VIDEO_CATEGORIES) {
    if (cat === 'general') continue;
    const prof = CATEGORY_PROFILES[cat];
    let score = 0;
    const hits: string[] = [];

    if (titleLow.includes(cat) || promptLow.includes(cat)) {
      score += 4.5;
      hits.push(cat);
    }

    for (const kw of prof.strongKeywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(`\\b${escaped}\\b`, 'gi');
      if (rx.test(titleLow)) {
        score += 2.6;
        hits.push(kw);
      }
      const bodyMatches = bodyLow.match(rx);
      if (bodyMatches && bodyMatches.length > 0) {
        score += Math.min(4.5, bodyMatches.length * 1.15);
        if (!hits.includes(kw)) hits.push(kw);
      }
    }

    for (const rule of prof.phraseTriggers) {
      const rxGlobal = new RegExp(rule.regex.source, 'gi');
      const matches = combined.match(rxGlobal);
      if (matches && matches.length > 0) {
        score += Math.min(4.0, matches.length * 1.4);
      }
    }

    ranked.push({ category: cat, score, hits });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 2.0) {
    return {
      category: 'general',
      confidence: 0.35,
      reason: 'Auto-detected General profile across transcript content',
    };
  }

  const best = ranked[0];
  const secondScore = ranked[1]?.score || 0;
  const confidence = Math.round(
    Math.min(0.99, Math.max(0.45, best.score / Math.max(best.score + secondScore * 0.6, 6.0))) * 100
  ) / 100;
  const sampleHits = best.hits.slice(0, 4).join(', ');
  return {
    category: best.category,
    confidence,
    reason: sampleHits
      ? `Auto-detected ${CATEGORY_PROFILES[best.category].label} (${sampleHits})`
      : `Auto-detected ${CATEGORY_PROFILES[best.category].label}`,
  };
}

export function inferClipTriggersAndGamingType(
  text: string,
  videoCategory: VideoCategory
): { viral_triggers: string[]; gaming_clip_type?: GamingClipType } {
  const low = (text || '').toLowerCase();
  const prof = CATEGORY_PROFILES[videoCategory] || CATEGORY_PROFILES.general;
  const triggers: string[] = [];

  for (const rule of prof.phraseTriggers) {
    if (rule.regex.test(low) && !triggers.includes(rule.label)) {
      triggers.push(rule.label);
    }
  }

  if (videoCategory !== 'gaming') {
    return { viral_triggers: triggers.slice(0, 4) };
  }

  const gameplayHits = GAMING_GAMEPLAY_CUES.filter((c) => low.includes(c)).length;
  const commentaryHits =
    GAMING_COMMENTARY_CUES.filter((c) => low.includes(c)).length +
    (text.includes('!') || text.includes('?') ? 1 : 0);

  let gaming_clip_type: GamingClipType = 'gameplay_highlight';
  if (gameplayHits > 0 && commentaryHits > 0) {
    gaming_clip_type = 'synced_gameplay_reaction';
    if (!triggers.includes('Synced Gameplay + Reaction')) {
      triggers.push('Synced Gameplay + Reaction');
    }
  } else if (commentaryHits > gameplayHits && commentaryHits > 0) {
    gaming_clip_type = 'commentary_highlight';
  }

  return {
    viral_triggers: triggers.slice(0, 4),
    gaming_clip_type,
  };
}

export function buildCategoryPromptInstructions(
  forcedOrDetected: VideoCategory | 'auto'
): string {
  if (forcedOrDetected === 'auto' || forcedOrDetected === 'general') {
    const summaryLines = (
      [
        'business',
        'comedy',
        'motivation',
        'politics',
        'sports',
        'relationships',
        'technology',
        'education',
        'gaming',
      ] as VideoCategory[]
    ).map((cat) => {
      const p = CATEGORY_PROFILES[cat];
      return `- ${p.label.toUpperCase()} (${cat}): Look for ${p.rules.join('; ')}. Viral trigger: ${p.viralTrigger}.`;
    });

    return [
      'CATEGORY-SPECIFIC VIRAL INTELLIGENCE:',
      '1. Automatically identify the primary video category (`business`, `comedy`, `motivation`, `politics`, `sports`, `relationships`, `technology`, `education`, `gaming`, or `general`) based on the title and transcript.',
      '2. Apply the matching category-specific viral detection rules:',
      ...summaryLines,
      `3. For GAMING videos: ${CATEGORY_PROFILES.gaming.extraInstructions}`,
    ].join('\n');
  }

  const p = CATEGORY_PROFILES[forcedOrDetected];
  return [
    `CATEGORY-SPECIFIC VIRAL INTELLIGENCE — ACTIVE CATEGORY: ${p.label.toUpperCase()} (${p.category}):`,
    `Viral trigger: ${p.viralTrigger}`,
    'Prioritize moments that hit these exact category detection rules:',
    ...p.rules.map((r) => `- ${r}`),
    ...(p.extraInstructions ? [p.extraInstructions] : []),
  ].join('\n');
}
