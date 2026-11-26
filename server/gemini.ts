import { GoogleGenAI, Type } from '@google/genai';

export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
export const VIRAL_ANALYSIS_MODEL = 'gemini-4-hydrogen';

export interface WordTimestamp {
  word: string;
  start_sec: number;
  end_sec: number;
  confidence: number;
}

export interface TranscriptSegment {
  id: number;
  start_sec: number;
  end_sec: number;
  text: string;
  words: WordTimestamp[];
}

export interface TranscriptData {
  video_hash: string;
  source_path: string;
  language: string;
  duration_sec: number;
  model_name: string;
  created_at_iso: string;
  segments: TranscriptSegment[];
}

export type ClipCategory = 'lesson' | 'entertainment' | 'insight' | 'hook';
export type ClipSentiment = 'Positive' | 'Negative' | 'Neutral';

export interface ViralClipCandidate {
  id: string;
  title: string;
  category: ClipCategory;
  sentiment: ClipSentiment;
  start_sec: number;
  end_sec: number;
  hook_score: number;
  lesson_score: number;
  entertainment_score: number;
  reason: string;
  caption_hook: string;
  tags: string[];
  snapped_to_words: boolean;
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Check your API key in the Settings > Secrets panel.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function normalizeAudioMimeType(rawMime?: string | null, originalName?: string): string {
  const base = String(rawMime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const aliasMap: Record<string, string> = {
    'audio/x-m4a': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/mpeg': 'audio/mp3',
    'audio/x-mpeg': 'audio/mp3',
    'video/webm': 'audio/webm',
    'video/mp4': 'audio/mp4',
  };

  if (base && aliasMap[base]) {
    return aliasMap[base];
  }
  if (base.startsWith('audio/')) {
    return base;
  }

  const ext = (originalName || '').split('.').pop()?.toLowerCase();
  if (ext === 'mp3') return 'audio/mp3';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'aac') return 'audio/aac';
  return 'audio/webm';
}

export interface GeminiErrorInfo {
  status: number;
  message: string;
}

export function formatGeminiError(err: unknown): GeminiErrorInfo {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Gemini API request failed');
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('gemini_api_key is not configured')
  ) {
    return {
      status: 403,
      message:
        'Gemini API key is missing or unauthorized. Please verify your API key in the Settings > Secrets panel.',
    };
  }

  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      status: 429,
      message:
        'Gemini API rate limit or quota exceeded (429). Wait a moment and retry, or check your key tier in Settings > Secrets.',
    };
  }

  if (lower.includes('not_found') || lower.includes('404')) {
    return {
      status: 404,
      message: `Requested Gemini model was not found: ${rawMessage}`,
    };
  }

  if (lower.includes('invalid_argument') || lower.includes('400')) {
    return {
      status: 400,
      message: `Invalid request payload for Gemini AI: ${rawMessage}`,
    };
  }

  return {
    status: 500,
    message: rawMessage || 'Gemini AI request failed.',
  };
}

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('500') ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed')
  );
}

async function withGeminiRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetryableError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function transcribeAudioBuffer(params: {
  audioBuffer: Buffer;
  mimeType: string;
  prompt?: string;
}): Promise<{ text: string; model: string; mimeType: string }> {
  const ai = getGeminiClient();
  const base64AudioString = params.audioBuffer.toString('base64');
  const instruction =
    params.prompt?.trim() ||
    'Transcribe this spoken audio accurately into clean text with proper punctuation.';

  const audioPart = {
    inlineData: {
      mimeType: params.mimeType,
      data: base64AudioString,
    },
  };

  return withGeminiRetry(async () => {
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: {
        parts: [audioPart, { text: instruction }],
      },
    });
    return {
      text: (response.text ?? '').trim(),
      model: TRANSCRIBE_MODEL,
      mimeType: params.mimeType,
    };
  });
}

export function formatBracketTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `[${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`;
  }
  return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`;
}

export function formatSrtTimestamp(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(msTotal / 3_600_000);
  const mins = Math.floor((msTotal % 3_600_000) / 60_000);
  const secs = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function segmentsToSrt(segments: Array<{ start_sec: number; end_sec: number; text: string }>): string {
  return segments
    .filter((seg) => seg.text.trim().length > 0)
    .map(
      (seg, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(seg.start_sec)} --> ${formatSrtTimestamp(
          Math.max(seg.start_sec + 0.3, seg.end_sec)
        )}\n${seg.text.trim()}`
    )
    .join('\n\n');
}

export function segmentsToTimestampedText(
  segments: Array<{ start_sec: number; text: string }>
): string {
  return segments
    .filter((seg) => seg.text.trim().length > 0)
    .map((seg) => `${formatBracketTimestamp(seg.start_sec)} ${seg.text.trim()}`)
    .join('\n');
}

export function buildWordsForSegment(text: string, startSec: number, endSec: number): WordTimestamp[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const span = Math.max(0.2, endSec - startSec);
  const step = span / tokens.length;
  return tokens.map((word, idx) => {
    const ws = Math.round((startSec + idx * step) * 1000) / 1000;
    const we = Math.round(Math.min(endSec, ws + step * 0.9) * 1000) / 1000;
    return { word, start_sec: ws, end_sec: we, confidence: 0.95 };
  });
}

export function parseTimestampedChunkOutput(params: {
  rawText: string;
  chunkStartSec: number;
  chunkDurationSec: number;
  totalDurationSec: number;
}): Array<{ start_sec: number; end_sec: number; text: string }> {
  // Split inline timestamps onto separate lines if the model emitted multiple timestamps on one line
  const normalizedRaw = params.rawText.replace(
    /\s+(?=\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\])/g,
    '\n'
  );
  const rawLines = normalizedRaw
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (rawLines.length === 0) return [];

  const tsRegex = /^[\[(\*]*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?[\])\*]*\s*(?:[-–—>|:]\s*)?(.*)$/;
  const parsed: Array<{ start_sec: number | null; text: string }> = [];
  let hasAnyTimestamp = false;

  for (const line of rawLines) {
    const m = line.match(tsRegex);
    if (m && m[5]?.trim()) {
      const hrs = m[1] ? Number(m[1]) : 0;
      const mins = Number(m[2]);
      const secs = Number(m[3]);
      const ms = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
      const relSec = hrs * 3600 + mins * 60 + secs + ms;
      const absSec = Math.min(
        Math.max(params.chunkStartSec, params.chunkStartSec + relSec),
        Math.max(params.chunkStartSec + 0.5, params.totalDurationSec - 0.25)
      );
      parsed.push({ start_sec: absSec, text: m[5].trim() });
      hasAnyTimestamp = true;
    } else {
      parsed.push({ start_sec: null, text: line.replace(/^[-*•]\s*/, '').trim() });
    }
  }

  // Fallback if model returned prose without line timestamps
  if (!hasAnyTimestamp) {
    const joined = parsed.map((p) => p.text).join(' ').trim();
    if (!joined) return [];
    const sentences = joined
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const segments = sentences.length > 0 ? sentences : [joined];
    const safeChunkDur = Math.max(1, params.chunkDurationSec);
    const step = safeChunkDur / segments.length;
    return segments.map((text, idx) => {
      const s = Math.round((params.chunkStartSec + idx * step) * 1000) / 1000;
      const e = Math.round(
        Math.min(params.totalDurationSec, params.chunkStartSec + (idx + 1) * step - 0.05) * 1000
      ) / 1000;
      return { start_sec: s, end_sec: Math.max(s + 0.4, e), text };
    });
  }

  // Filter out empty lines and ensure strictly monotonic start times
  const cleanItems = parsed.filter((p) => p.text.length > 0);
  const chunkEnd = Math.min(params.totalDurationSec, params.chunkStartSec + params.chunkDurationSec);
  const timed: Array<{ start_sec: number; end_sec: number; text: string }> = [];

  for (let i = 0; i < cleanItems.length; i++) {
    const prevEnd = timed.length > 0 ? timed[timed.length - 1].start_sec + 0.35 : params.chunkStartSec;
    const rawStart = cleanItems[i].start_sec;
    const startSec =
      rawStart !== null
        ? Math.max(prevEnd, Math.min(rawStart, chunkEnd - 0.4))
        : Math.min(prevEnd + 0.1, chunkEnd - 0.4);
    timed.push({ start_sec: Math.round(startSec * 1000) / 1000, end_sec: chunkEnd, text: cleanItems[i].text });
  }

  for (let i = 0; i < timed.length; i++) {
    const nextStart = i < timed.length - 1 ? timed[i + 1].start_sec : chunkEnd;
    timed[i].end_sec = Math.round(Math.max(timed[i].start_sec + 0.4, nextStart - 0.04) * 1000) / 1000;
  }

  return timed;
}

export async function transcribeAudioWithTimestamps(params: {
  audioBuffer: Buffer;
  mimeType: string;
  prompt?: string;
  durationSec?: number;
  sourceLabel?: string;
  videoHash?: string;
}): Promise<{
  text: string;
  model: string;
  mimeType: string;
  timestamped: boolean;
  duration_sec: number;
  segments: TranscriptSegment[];
  srt: string;
  transcript: TranscriptData;
}> {
  const safeDuration = Math.max(4, Number(params.durationSec) || 600);
  const guidance = params.prompt?.trim();
  const timestampPrompt = [
    'Transcribe all spoken words in this audio accurately into sentences or natural spoken phrases.',
    'Put each sentence or spoken phrase on a new line prefixed with its exact start timestamp from the beginning of the audio in [MM:SS] format (or [HH:MM:SS] if over an hour), for example:',
    '[00:03] First spoken sentence.',
    '[00:09] Second spoken sentence.',
    'Make sure the timestamps match the exact minute and second each sentence begins in the audio.',
    guidance ? `Additional instructions: ${guidance}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await transcribeAudioBuffer({
    audioBuffer: params.audioBuffer,
    mimeType: params.mimeType,
    prompt: timestampPrompt,
  });

  const rawSegments = result.text.trim()
    ? parseTimestampedChunkOutput({
        rawText: result.text,
        chunkStartSec: 0,
        chunkDurationSec: safeDuration,
        totalDurationSec: safeDuration,
      })
    : [];

  const finalDuration = Math.max(
    Number(params.durationSec) || 0,
    rawSegments[rawSegments.length - 1]?.end_sec || 0,
    1
  );

  const segments: TranscriptSegment[] = rawSegments.map((seg, idx) => ({
    id: idx,
    start_sec: seg.start_sec,
    end_sec: seg.end_sec,
    text: seg.text,
    words: buildWordsForSegment(seg.text, seg.start_sec, seg.end_sec),
  }));

  const transcript: TranscriptData = {
    video_hash: params.videoHash || `audio_${Date.now()}`,
    source_path: params.sourceLabel || 'uploaded-audio',
    language: 'en',
    duration_sec: Math.round(finalDuration * 1000) / 1000,
    model_name: TRANSCRIBE_MODEL,
    created_at_iso: new Date().toISOString(),
    segments,
  };

  return {
    text: segments.length > 0 ? segmentsToTimestampedText(segments) : result.text,
    model: TRANSCRIBE_MODEL,
    mimeType: result.mimeType,
    timestamped: true,
    duration_sec: transcript.duration_sec,
    segments,
    srt: segmentsToSrt(segments),
    transcript,
  };
}

export async function transcribeVideoChunksWithGemini(params: {
  videoHash: string;
  sourcePath: string;
  totalDurationSec: number;
  chunks: Array<{ buffer: Buffer; mimeType: string; startSec: number; durationSec: number }>;
  prompt?: string;
}): Promise<TranscriptData> {
  const allRawSegments: Array<{ start_sec: number; end_sec: number; text: string }> = [];
  const extra = params.prompt?.trim();

  for (const chunk of params.chunks) {
    const result = await transcribeAudioBuffer({
      audioBuffer: chunk.buffer,
      mimeType: chunk.mimeType,
      prompt: [
        'Transcribe all spoken words in this audio accurately. Format each sentence or natural spoken phrase on a new line prefixed with its exact start timestamp from the start of this audio clip in [MM:SS] format (for example: [00:00] First sentence here.). If there is no speech, respond with an empty string.',
        extra ? `Additional instructions: ${extra}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    if (result.text.trim()) {
      const segs = parseTimestampedChunkOutput({
        rawText: result.text,
        chunkStartSec: chunk.startSec,
        chunkDurationSec: chunk.durationSec,
        totalDurationSec: params.totalDurationSec,
      });
      allRawSegments.push(...segs);
    }
  }

  const segments: TranscriptSegment[] = allRawSegments.map((seg, idx) => ({
    id: idx,
    start_sec: seg.start_sec,
    end_sec: seg.end_sec,
    text: seg.text,
    words: buildWordsForSegment(seg.text, seg.start_sec, seg.end_sec),
  }));

  return {
    video_hash: params.videoHash,
    source_path: params.sourcePath,
    language: 'en',
    duration_sec: params.totalDurationSec,
    model_name: TRANSCRIBE_MODEL,
    created_at_iso: new Date().toISOString(),
    segments,
  };
}

function snapTimestampToWords(
  targetSec: number,
  words: WordTimestamp[],
  edge: 'start' | 'end'
): number {
  if (words.length === 0) return targetSec;
  let best = targetSec;
  let bestDist = Infinity;
  for (const w of words) {
    const candidate = edge === 'start' ? w.start_sec : w.end_sec;
    const dist = Math.abs(candidate - targetSec);
    if (dist < bestDist && dist <= 2.5) {
      bestDist = dist;
      best = candidate;
    }
  }
  return Math.round(best * 1000) / 1000;
}

export async function analyzeTranscriptForViralClips(params: {
  transcript: TranscriptData;
  prompt?: string;
  minClipSec?: number;
  maxClipSec?: number;
  maxClips?: number;
}): Promise<ViralClipCandidate[]> {
  const { transcript } = params;
  if (!transcript.segments || transcript.segments.length === 0) {
    throw new Error('Cannot analyze an empty transcript for viral clips.');
  }

  const ai = getGeminiClient();
  const totalDur = Math.max(1, transcript.duration_sec || transcript.segments[transcript.segments.length - 1].end_sec);
  const minClipSec = Math.min(Math.max(2, params.minClipSec ?? 6), Math.max(2, totalDur * 0.8));
  const maxClipSec = Math.min(Math.max(minClipSec + 2, params.maxClipSec ?? 45), totalDur);
  const maxClips = Math.min(Math.max(1, params.maxClips ?? 6), 10);

  const formattedTranscript = transcript.segments
    .map((s) => `[${s.start_sec.toFixed(2)}s - ${s.end_sec.toFixed(2)}s] ${s.text}`)
    .join('\n');

  const userGoal =
    params.prompt?.trim() ||
    'Identify the highest-retention standalone viral short-form clips: bold hooks, surprising insights, emotional stories, and actionable lessons.';

  const analysisPrompt = [
    `You are an expert short-form video editor extracting viral clips for YouTube Shorts, TikTok, and Instagram Reels.`,
    `Video duration: ${totalDur.toFixed(2)} seconds.`,
    `Target clip length: between ${minClipSec.toFixed(1)}s and ${maxClipSec.toFixed(1)}s (extract up to ${maxClips} distinct, non-overlapping clips ranked by viral strength).`,
    `Editorial focus: ${userGoal}`,
    ``,
    `Transcript with timestamps:`,
    formattedTranscript,
    ``,
    `Return JSON array items with exact start_sec and end_sec grounded in the transcript timestamps, category ('hook' | 'lesson' | 'entertainment' | 'insight'), sentiment ('Positive' | 'Negative' | 'Neutral'), 1-10 scores (hook_score, lesson_score, entertainment_score), a punchy uppercase caption_hook (<= 48 chars), a 1-sentence editorial reason, and exactly 3 relevant social hashtags starting with #.`,
  ].join('\n');

  const rawJson = await withGeminiRetry(async () => {
    const response = await ai.models.generateContent({
      model: VIRAL_ANALYSIS_MODEL,
      contents: analysisPrompt,
      config: {
        systemInstruction:
          'Analyze video transcripts strictly based on the provided spoken segments and timestamps. Never invent timestamps outside the transcript duration.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Compelling short clip title' },
              category: {
                type: Type.STRING,
                description: 'One of: hook, lesson, entertainment, insight',
              },
              sentiment: {
                type: Type.STRING,
                description: 'Overall emotional tone: Positive, Negative, or Neutral',
              },
              start_sec: { type: Type.NUMBER, description: 'Clip start time in seconds' },
              end_sec: { type: Type.NUMBER, description: 'Clip end time in seconds' },
              hook_score: { type: Type.NUMBER, description: 'Scroll-stopping hook strength from 1 to 10' },
              lesson_score: { type: Type.NUMBER, description: 'Actionable takeaway value from 1 to 10' },
              entertainment_score: { type: Type.NUMBER, description: 'Storytelling/energy score from 1 to 10' },
              caption_hook: { type: Type.STRING, description: 'Short bold on-screen hook caption' },
              reason: { type: Type.STRING, description: 'Why this segment will perform as a viral clip' },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3 relevant social media hashtags starting with #',
              },
            },
          },
        },
      },
    });
    return (response.text ?? '[]').trim();
  });

  let parsed: any[] = [];
  try {
    const data = JSON.parse(rawJson);
    parsed = Array.isArray(data) ? data : [];
  } catch {
    throw new Error('Gemini returned malformed JSON during viral clip analysis.');
  }

  const allWords = transcript.segments.flatMap((s) => s.words || []);
  const validCategories = new Set<ClipCategory>(['hook', 'lesson', 'entertainment', 'insight']);
  const clampScore = (v: unknown, fallback = 7.5) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const normalized = n > 10 ? n / 10 : n;
    return Math.round(Math.min(10, Math.max(1, normalized)) * 10) / 10;
  };
  const normalizeSentiment = (v: unknown): ClipSentiment => {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'positive') return 'Positive';
    if (s === 'negative') return 'Negative';
    return 'Neutral';
  };

  const normalizedClips: ViralClipCandidate[] = parsed
    .slice(0, maxClips)
    .map((item, idx) => {
      let start = Math.max(0, Math.min(totalDur - 1, Number(item?.start_sec) || 0));
      let end = Math.max(start + 1, Math.min(totalDur, Number(item?.end_sec) || start + minClipSec));

      if (allWords.length > 0) {
        start = snapTimestampToWords(start, allWords, 'start');
        end = snapTimestampToWords(end, allWords, 'end');
      }
      if (end - start < 1.5) {
        end = Math.min(totalDur, start + Math.min(minClipSec, totalDur - start));
      }

      const rawCat = String(item?.category || 'hook').toLowerCase() as ClipCategory;
      const category: ClipCategory = validCategories.has(rawCat) ? rawCat : 'hook';

      const rawTags: string[] = Array.isArray(item?.tags) ? item.tags : [];
      const cleanTags = rawTags
        .map((t) => `#${String(t).trim().replace(/^#+/, '').replace(/[^a-zA-Z0-9_]/g, '')}`)
        .filter((t) => t.length > 2)
        .slice(0, 3);
      while (cleanTags.length < 3) {
        const fallback = ['#Shorts', '#ViralClips', '#Reels'][cleanTags.length];
        if (!cleanTags.includes(fallback)) cleanTags.push(fallback);
        else cleanTags.push(`#Clip${cleanTags.length + 1}`);
      }

      return {
        id: `clip_${String(idx + 1).padStart(2, '0')}`,
        title: String(item?.title || `Viral Clip ${idx + 1}`).trim(),
        category,
        sentiment: normalizeSentiment(item?.sentiment),
        start_sec: Math.round(start * 100) / 100,
        end_sec: Math.round(end * 100) / 100,
        hook_score: clampScore(item?.hook_score, 8.2),
        lesson_score: clampScore(item?.lesson_score, 7.6),
        entertainment_score: clampScore(item?.entertainment_score, 7.8),
        caption_hook: String(item?.caption_hook || 'WATCH THIS MOMENT').trim().slice(0, 64),
        reason: String(item?.reason || 'High-retention standalone segment from full video analysis.').trim(),
        tags: cleanTags,
        snapped_to_words: allWords.length > 0,
      };
    })
    .sort((a, b) => a.start_sec - b.start_sec)
    .map((clip, idx) => ({
      ...clip,
      id: `clip_${String(idx + 1).padStart(2, '0')}`,
    }));

  if (normalizedClips.length === 0) {
    throw new Error('Gemini analysis did not return any valid viral clip candidates.');
  }

  return normalizedClips;
}
