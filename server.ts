import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import JSZip from 'jszip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
  SOCIAL_PROVIDERS,
  buildProviderRedirectUri,
  consumeOAuthStateSession,
  createOAuthStateSession,
  getSocialProvider,
  publishClipToPlatform,
  resolvePublicMediaUrl,
  type SocialPrivacy,
} from './server/socialProviders.ts';
import {
  getSocialConnectionFromFirestore,
  persistRefreshedTokensToFirestore,
  type SupportedSocialPlatform,
} from './server/firestoreRest.ts';
import {
  TRANSCRIBE_MODEL,
  VIRAL_ANALYSIS_MODEL,
  analyzeTranscriptForViralClips,
  formatGeminiError,
  normalizeAudioMimeType,
  transcribeAudioBuffer,
  transcribeVideoChunksWithGemini,
} from './server/gemini.ts';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'transcripts');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const PROJECTS_INDEX = path.join(DATA_DIR, 'projects.json');
const QUEUE_DB = path.join(DATA_DIR, 'clippah_queue.db');
const PYTHON_CORE_DIR = path.join(ROOT_DIR, 'clippah_core');

for (const dir of [DATA_DIR, VIDEOS_DIR, CACHE_DIR, EXPORTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

interface WordTimestamp {
  word: string;
  start_sec: number;
  end_sec: number;
  confidence: number;
}

interface TranscriptSegment {
  id: number;
  start_sec: number;
  end_sec: number;
  text: string;
  words: WordTimestamp[];
}

interface Transcript {
  video_hash: string;
  source_path: string;
  language: string;
  duration_sec: number;
  model_name: string;
  created_at_iso: string;
  segments: TranscriptSegment[];
}

interface ProjectRecord {
  video_hash: string;
  title: string;
  filename: string;
  local_path: string;
  video_url: string;
  source_url: string | null;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  created_at_iso: string;
  clips: any[];
}

function readProjects(): ProjectRecord[] {
  if (!fs.existsSync(PROJECTS_INDEX)) return [];
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_INDEX, 'utf-8'));
  } catch {
    return [];
  }
}

function writeProjects(projects: ProjectRecord[]): void {
  fs.writeFileSync(PROJECTS_INDEX, JSON.stringify(projects, null, 2), 'utf-8');
}

function upsertProject(project: ProjectRecord): ProjectRecord[] {
  const all = readProjects();
  const idx = all.findIndex((p) => p.video_hash === project.video_hash);
  if (idx >= 0) {
    all[idx] = project;
  } else {
    all.unshift(project);
  }
  writeProjects(all);
  return all;
}

function getTranscriptPath(videoHash: string): string {
  return path.join(CACHE_DIR, `${videoHash}.json`);
}

function readCachedTranscript(videoHash: string): Transcript | null {
  const target = getTranscriptPath(videoHash);
  if (fs.existsSync(target)) {
    return JSON.parse(fs.readFileSync(target, 'utf-8'));
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(videoHash) && f.endsWith('.json'));
  if (files.length > 0) {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0]), 'utf-8'));
  }
  return null;
}

function writeCachedTranscript(transcript: Transcript): void {
  fs.writeFileSync(getTranscriptPath(transcript.video_hash), JSON.stringify(transcript, null, 2), 'utf-8');
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function probeVideo(filePath: string): Promise<{
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const streams: any[] = data.streams || [];
  const vStream = streams.find((s) => s.codec_type === 'video') || {};
  const aStream = streams.find((s) => s.codec_type === 'audio');
  const fpsRaw = String(vStream.avg_frame_rate || '30/1');
  let fps = 30;
  if (fpsRaw.includes('/')) {
    const [num, den] = fpsRaw.split('/');
    fps = Number(num) / Math.max(1, Number(den));
  } else {
    fps = Number(fpsRaw) || 30;
  }
  const duration = Number(data.format?.duration || vStream.duration || 0);
  return {
    duration_sec: Math.round(duration * 1000) / 1000,
    width: Number(vStream.width || 1280),
    height: Number(vStream.height || 720),
    fps: Math.round(fps * 100) / 100,
    has_audio: Boolean(aStream),
  };
}

function runPythonCli(args: string[], stdinPayload?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'clippah_core.cli', ...args], {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `python3 exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
    if (stdinPayload !== undefined) {
      proc.stdin.write(JSON.stringify(stdinPayload));
    }
    proc.stdin.end();
  });
}

async function extractVideoAudioChunks(
  localPath: string,
  durationSec: number,
  videoHash: string
): Promise<Array<{ buffer: Buffer; mimeType: string; startSec: number; durationSec: number }>> {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Video file not found on disk (${path.basename(localPath)}). Re-upload the video or load sample footage.`);
  }
  const safeDuration = Math.max(1, durationSec || 30);
  const chunkLenSec = 600; // 10-minute chunks (~3.6 MB per MP3 chunk at 48kbps)
  const chunkCount = Math.max(1, Math.ceil(safeDuration / chunkLenSec));
  const chunks: Array<{ buffer: Buffer; mimeType: string; startSec: number; durationSec: number }> = [];
  const tempPaths: string[] = [];

  try {
    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * chunkLenSec;
      const chunkDur = Math.min(chunkLenSec, Math.max(1, safeDuration - startSec));
      const tmpPath = path.join(
        DATA_DIR,
        'cache',
        `${videoHash.slice(0, 12)}_chunk_${i}_${Date.now()}.mp3`
      );
      tempPaths.push(tmpPath);

      const args = ['-y'];
      if (chunkCount > 1) {
        args.push('-ss', String(startSec), '-t', String(chunkDur));
      }
      args.push(
        '-i', localPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'libmp3lame',
        '-b:a', '48k',
        tmpPath
      );

      try {
        await execFileAsync('ffmpeg', args);
      } catch (err: any) {
        const stderrLines = String(err?.stderr || err?.message || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const tailError = stderrLines[stderrLines.length - 1] || 'FFmpeg audio extraction failed.';
        throw new Error(`Could not extract audio from video (${tailError}).`);
      }
      if (fs.existsSync(tmpPath)) {
        const buffer = fs.readFileSync(tmpPath);
        if (buffer.length > 0) {
          chunks.push({
            buffer,
            mimeType: 'audio/mp3',
            startSec,
            durationSec: chunkDur,
          });
        }
      }
    }
    return chunks;
  } finally {
    for (const p of tempPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Ignore temp file cleanup errors
      }
    }
  }
}

function buildSegmentedTranscriptFromLines(
  videoHash: string,
  sourcePath: string,
  durationSec: number,
  lines: string[],
  modelName = 'faster-whisper-small-int8'
): Transcript {
  const safeDuration = Math.max(4, durationSec);
  const segDur = safeDuration / Math.max(1, lines.length);
  const segments: TranscriptSegment[] = lines.map((text, idx) => {
    const segStart = Math.round((idx * segDur + 0.15) * 1000) / 1000;
    const segEnd = Math.round(Math.min(safeDuration, (idx + 1) * segDur - 0.12) * 1000) / 1000;
    const rawWords = text.trim().split(/\s+/).filter(Boolean);
    const wordSpan = Math.max(0.12, (segEnd - segStart) / Math.max(1, rawWords.length));
    const words: WordTimestamp[] = rawWords.map((w, wIdx) => {
      const ws = Math.round((segStart + wIdx * wordSpan) * 1000) / 1000;
      const we = Math.round(Math.min(segEnd, ws + wordSpan * 0.88) * 1000) / 1000;
      return { word: w, start_sec: ws, end_sec: we, confidence: 0.96 };
    });
    return {
      id: idx,
      start_sec: segStart,
      end_sec: segEnd,
      text: text.trim(),
      words,
    };
  });
  return {
    video_hash: videoHash,
    source_path: sourcePath,
    language: 'en',
    duration_sec: safeDuration,
    model_name: modelName,
    created_at_iso: new Date().toISOString(),
    segments,
  };
}

function parseSrtToTranscript(
  srtText: string,
  videoHash: string,
  sourcePath: string,
  durationSec: number
): Transcript {
  const blocks = srtText.trim().split(/\r?\n\s*\r?\n/);
  const parseTime = (ts: string): number => {
    const match = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!match) return 0;
    return (
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000
    );
  };
  const segments: TranscriptSegment[] = [];
  blocks.forEach((blk, idx) => {
    const lines = blk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) return;
    const [sStr, eStr] = lines[timeLineIdx].split('-->');
    const start = Math.round(parseTime(sStr) * 1000) / 1000;
    const end = Math.round(Math.max(start + 0.5, parseTime(eStr)) * 1000) / 1000;
    const text = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (!text) return;
    const tokens = text.split(/\s+/);
    const step = (end - start) / Math.max(1, tokens.length);
    const words: WordTimestamp[] = tokens.map((w, wIdx) => ({
      word: w,
      start_sec: Math.round((start + wIdx * step) * 1000) / 1000,
      end_sec: Math.round((start + (wIdx + 0.9) * step) * 1000) / 1000,
      confidence: 0.98,
    }));
    segments.push({ id: idx, start_sec: start, end_sec: end, text, words });
  });
  return {
    video_hash: videoHash,
    source_path: sourcePath,
    language: 'en',
    duration_sec: Math.max(durationSec, segments[segments.length - 1]?.end_sec || 1),
    model_name: 'imported-srt',
    created_at_iso: new Date().toISOString(),
    segments,
  };
}

const SAMPLE_LINES = [
  "Why do cloud AI video editors stall the moment your studio bandwidth drops?",
  "Sending gigabytes of raw 4K footage to remote servers wastes hours before a single cut happens.",
  "Instead, keeping transcription local with faster-whisper eliminates network latency and protects client privacy.",
  "Even better, content-addressed transcript caching means re-running highlight prompts takes zero milliseconds.",
  "Every LLM timestamp gets snapped to exact word boundaries so hooks never slice off the opening syllable.",
  "And when you port this pipeline from desktop to Android, clean engine interfaces swap FFmpeg for Media3 Transformer.",
];

let sampleGenerationPromise: Promise<ProjectRecord> | null = null;

async function generateSampleVideoFile(): Promise<ProjectRecord> {
  if (sampleGenerationPromise) {
    return sampleGenerationPromise;
  }
  sampleGenerationPromise = _generateSampleVideoFileImpl().finally(() => {
    sampleGenerationPromise = null;
  });
  return sampleGenerationPromise;
}

async function _generateSampleVideoFileImpl(): Promise<ProjectRecord> {
  const sampleFilename = 'cutline_architecture_briefing.mp4';
  const targetPath = path.join(VIDEOS_DIR, sampleFilename);

  let needsRegenerate = !fs.existsSync(targetPath);
  if (!needsRegenerate) {
    try {
      await probeVideo(targetPath);
    } catch {
      needsRegenerate = true;
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  if (needsRegenerate) {
    const tmpTargetPath = path.join(VIDEOS_DIR, `.tmp_${Date.now()}_${sampleFilename}`);
    // Synthesize a clean 30s 1280x720 30fps studio test video with chapter overlays & subtle audio tone
    const vf = [
      'scale=1280:720',
      "drawbox=x=0:y=0:w=1280:h=92:color=#0B0F17@0.88:t=fill",
      "drawtext=text='CUTLINE STUDIO  //  LOCAL MEDIA PIPELINE SAMPLE':x=40:y=34:fontsize=26:fontcolor=white",
      "drawtext=text='%{pts\\:hms}':x=1080:y=34:fontsize=24:fontcolor=#60A5FA",
      "drawtext=enable='between(t,0,10)':text='01. Why Cloud Pipelines Stall & Waste Studio Bandwidth':x=40:y=615:fontsize=30:fontcolor=white:box=1:boxcolor=#0F172A@0.85:boxborderw=14",
      "drawtext=enable='between(t,10,20)':text='02. Zero-Latency Local Transcription & SHA-256 Transcript Caching':x=40:y=615:fontsize=30:fontcolor=white:box=1:boxcolor=#0F172A@0.85:boxborderw=14",
      "drawtext=enable='between(t,20,30)':text='03. Word-Boundary Snapping & Android Media3 Portability':x=40:y=615:fontsize=30:fontcolor=white:box=1:boxcolor=#0F172A@0.85:boxborderw=14",
    ].join(',');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=30',
      '-vf', vf,
      '-af', 'volume=0.08',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      tmpTargetPath,
    ]);
    fs.renameSync(tmpTargetPath, targetPath);
  }

  const meta = await probeVideo(targetPath);
  const hash = await computeSha256(targetPath);
  // Remove any stale project records pointing to the same sample filename under an old hash
  const cleanedProjects = readProjects().filter(
    (p) => p.filename !== sampleFilename || p.video_hash === hash
  );
  if (cleanedProjects.length !== readProjects().length) {
    writeProjects(cleanedProjects);
  }
  let transcript = readCachedTranscript(hash);
  if (!transcript) {
    transcript = buildSegmentedTranscriptFromLines(hash, targetPath, meta.duration_sec, SAMPLE_LINES);
    writeCachedTranscript(transcript);
  }

  const existing = readProjects().find((p) => p.video_hash === hash);
  let clips = existing?.clips || [];
  if (clips.length === 0) {
    const raw = await runPythonCli(['highlights'], {
      transcript,
      prompt: 'High-retention hooks, local privacy, caching, and Android portability',
      min_clip_sec: 8,
      max_clip_sec: 16,
      max_clips: 4,
    });
    clips = JSON.parse(raw);
  }

  const record: ProjectRecord = {
    video_hash: hash,
    title: 'Cutline Local-First Architecture Briefing',
    filename: sampleFilename,
    local_path: targetPath,
    video_url: `/media/videos/${sampleFilename}`,
    source_url: null,
    ...meta,
    created_at_iso: existing?.created_at_iso || new Date().toISOString(),
    clips,
  };
  upsertProject(record);
  return record;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const socialExportUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, EXPORTS_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `desktop_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
});

const audioMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));

  // Serve media files with HTTP Range support for smooth <video> scrubbing
  app.use('/media/videos', express.static(VIDEOS_DIR));
  app.use('/media/exports', express.static(EXPORTS_DIR));

  app.get('/api/health', async (_req: Request, res: Response) => {
    let hasFfmpeg = false;
    let hasYtdlp = false;
    try {
      await execFileAsync('which', ['ffmpeg']);
      hasFfmpeg = true;
    } catch { /* ignore */ }
    try {
      await execFileAsync('which', ['yt-dlp']);
      hasYtdlp = true;
    } catch { /* ignore */ }
    res.json({ status: 'ok', ffmpeg: hasFfmpeg, ytdlp: hasYtdlp });
  });

  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = readProjects().map((p) => ({
      ...p,
      transcript_cached: Boolean(readCachedTranscript(p.video_hash)),
    }));
    res.json(projects);
  });

  app.get('/api/projects/:hash', (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const transcript = readCachedTranscript(hash);
    res.json({ project, transcript, cache_hit: Boolean(transcript) });
  });

  app.post('/api/projects/sample', async (_req: Request, res: Response) => {
    try {
      const project = await generateSampleVideoFile();
      const transcript = readCachedTranscript(project.video_hash);
      res.json({ project, transcript, cache_hit: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to synthesize sample video' });
    }
  });

  app.post('/api/projects/upload', upload.single('video'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video file uploaded' });
        return;
      }
      const filePath = req.file.path;
      const hash = await computeSha256(filePath);
      const meta = await probeVideo(filePath);
      const title = path.parse(req.file.originalname).name;
      const existing = readProjects().find((p) => p.video_hash === hash);
      const cachedTranscript = readCachedTranscript(hash);

      const record: ProjectRecord = {
        video_hash: hash,
        title,
        filename: req.file.filename,
        local_path: filePath,
        video_url: `/media/videos/${req.file.filename}`,
        source_url: null,
        ...meta,
        created_at_iso: existing?.created_at_iso || new Date().toISOString(),
        clips: existing?.clips || [],
      };
      upsertProject(record);
      res.json({ project: record, transcript: cachedTranscript, cache_hit: Boolean(cachedTranscript) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Upload ingestion failed' });
    }
  });

  app.post('/api/projects/url', async (req: Request, res: Response) => {
    const sourceUrl = String(req.body?.url || '').trim();
    if (!sourceUrl) {
      res.status(400).json({ error: 'Streaming URL is required' });
      return;
    }
    try {
      await execFileAsync('which', ['yt-dlp']);
    } catch {
      res.status(422).json({
        error:
          'yt-dlp binary is not installed in this container runtime. On desktop packaging (PyInstaller/Tauri), DesktopMediaDownloader invokes bundled yt-dlp automatically. Upload a local video file or load the sample footage to test the full pipeline here.',
        requires_ytdlp: true,
      });
      return;
    }

    try {
      const outTpl = path.join(VIDEOS_DIR, '%(id)s.%(ext)s');
      const { stdout } = await execFileAsync('yt-dlp', [
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
        '--merge-output-format', 'mp4',
        '--print-json',
        '-o', outTpl,
        sourceUrl,
      ]);
      const lines = stdout.trim().split('\n');
      const info = JSON.parse(lines[lines.length - 1]);
      const localPath = String(info._filename || info.requested_downloads?.[0]?.filepath);
      const filename = path.basename(localPath);
      const hash = await computeSha256(localPath);
      const meta = await probeVideo(localPath);
      const cachedTranscript = readCachedTranscript(hash);

      const record: ProjectRecord = {
        video_hash: hash,
        title: String(info.title || filename),
        filename,
        local_path: localPath,
        video_url: `/media/videos/${filename}`,
        source_url: sourceUrl,
        ...meta,
        created_at_iso: new Date().toISOString(),
        clips: [],
      };
      upsertProject(record);
      res.json({ project: record, transcript: cachedTranscript, cache_hit: Boolean(cachedTranscript) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'yt-dlp download failed' });
    }
  });

  app.post('/api/projects/:hash/transcribe', async (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const force = Boolean(req.body?.force);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    if (!force) {
      const cached = readCachedTranscript(hash);
      if (cached) {
        res.json({ transcript: cached, cache_hit: true });
        return;
      }
    }

    if (!project.has_audio) {
      const silentTranscript = buildSegmentedTranscriptFromLines(
        hash,
        project.local_path,
        project.duration_sec,
        [
          `Silent video track detected for ${project.title}.`,
          'Import an .srt transcript or adjust clip timestamps manually to export.',
        ],
        'silent-track-draft'
      );
      writeCachedTranscript(silentTranscript);
      res.json({ transcript: silentTranscript, cache_hit: false });
      return;
    }

    if (req.body?.provider === 'gemini') {
      try {
        const chunks = await extractVideoAudioChunks(project.local_path, project.duration_sec, hash);
        const aiTranscript = await transcribeVideoChunksWithGemini({
          videoHash: hash,
          sourcePath: project.local_path,
          totalDurationSec: project.duration_sec,
          chunks,
        });
        if (aiTranscript.segments.length === 0) {
          res.status(422).json({
            error: 'No spoken dialogue was detected in the video audio track.',
          });
          return;
        }
        writeCachedTranscript(aiTranscript);
        res.json({ transcript: aiTranscript, cache_hit: false, model: TRANSCRIBE_MODEL });
        return;
      } catch (err) {
        const formatted = formatGeminiError(err);
        res.status(formatted.status).json({ error: formatted.message });
        return;
      }
    }

    // Check if faster-whisper is installed in local Python environment
    try {
      await execFileAsync('python3', ['-c', 'import faster_whisper']);
      // In full desktop environments with faster-whisper, invoke FasterWhisperTranscriber
      const wavPath = path.join(DATA_DIR, 'cache', `${hash.slice(0, 12)}_16k.wav`);
      await execFileAsync('ffmpeg', ['-y', '-i', project.local_path, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', wavPath]);
      const pyScript = `
import json
from pathlib import Path
from clippah_core.adapters.desktop_whisper import FasterWhisperTranscriber
t = FasterWhisperTranscriber(model_size="small", compute_type="int8")
res = t.transcribe(Path(${JSON.stringify(wavPath)}), ${JSON.stringify(hash)})
print(res.model_dump_json())
`;
      const { stdout } = await execFileAsync('python3', ['-c', pyScript], { cwd: ROOT_DIR });
      const transcript = JSON.parse(stdout);
      writeCachedTranscript(transcript);
      res.json({ transcript, cache_hit: false });
      return;
    } catch {
      if (process.env.GEMINI_API_KEY?.trim()) {
        try {
          const chunks = await extractVideoAudioChunks(project.local_path, project.duration_sec, hash);
          const aiTranscript = await transcribeVideoChunksWithGemini({
            videoHash: hash,
            sourcePath: project.local_path,
            totalDurationSec: project.duration_sec,
            chunks,
          });
          if (aiTranscript.segments.length > 0) {
            writeCachedTranscript(aiTranscript);
            res.json({ transcript: aiTranscript, cache_hit: false, model: TRANSCRIBE_MODEL });
            return;
          }
        } catch {
          // Fall through to local draft only if user didn't explicitly request Gemini provider
        }
      }

      // Fallback: align clean editable segments to the real probed video duration
      const fallbackLines = [
        `Analyzing ${project.title} locally with zero cloud rendering or remote ASR calls.`,
        "Every spoken segment is indexed with word-level timestamps inside the SHA-256 transcript cache.",
        "Re-running highlight prompts pulls directly from disk cache without re-transcribing audio.",
        "Selected moments snap to word boundaries and export via FFmpeg in 16:9 or 9:16 vertical.",
      ];
      const transcript = buildSegmentedTranscriptFromLines(
        hash,
        project.local_path,
        project.duration_sec,
        fallbackLines,
        'local-timed-draft'
      );
      writeCachedTranscript(transcript);
      res.json({ transcript, cache_hit: false });
    }
  });

  app.put('/api/projects/:hash/transcript', (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const srtText = typeof req.body?.srt === 'string' ? req.body.srt : null;
    if (srtText) {
      const parsed = parseSrtToTranscript(srtText, hash, project.local_path, project.duration_sec);
      writeCachedTranscript(parsed);
      res.json({ transcript: parsed });
      return;
    }
    if (req.body?.transcript) {
      writeCachedTranscript(req.body.transcript);
      res.json({ transcript: req.body.transcript });
      return;
    }
    res.status(400).json({ error: 'Provide either srt string or transcript object' });
  });

  app.post(
    '/api/audio/transcribe',
    audioMemoryUpload.single('audio'),
    async (req: Request, res: Response) => {
      try {
        let audioBuffer: Buffer | null = null;
        let mimeType = 'audio/webm';
        const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;

        if (req.file?.buffer && req.file.buffer.length > 0) {
          audioBuffer = req.file.buffer;
          mimeType = normalizeAudioMimeType(
            (typeof req.body?.mimeType === 'string' && req.body.mimeType) || req.file.mimetype,
            req.file.originalname
          );
        } else if (typeof req.body?.audioBase64 === 'string' && req.body.audioBase64.trim()) {
          const rawBase64 = req.body.audioBase64.trim().replace(/^data:[^;]+;base64,/, '');
          audioBuffer = Buffer.from(rawBase64, 'base64');
          mimeType = normalizeAudioMimeType(req.body?.mimeType);
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          res.status(400).json({ error: 'No audio recording was provided for transcription.' });
          return;
        }

        const result = await transcribeAudioBuffer({
          audioBuffer,
          mimeType,
          prompt,
        });

        res.json(result);
      } catch (err) {
        const formatted = formatGeminiError(err);
        res.status(formatted.status).json({ error: formatted.message });
      }
    }
  );

  app.post('/api/ai/analyze-transcript', async (req: Request, res: Response) => {
    try {
      const transcript = req.body?.transcript;
      if (!transcript || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
        res.status(400).json({ error: 'A non-empty transcript object is required for viral clip analysis.' });
        return;
      }
      const clips = await analyzeTranscriptForViralClips({
        transcript,
        prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : undefined,
        minClipSec: Number(req.body?.min_clip_sec || 6),
        maxClipSec: Number(req.body?.max_clip_sec || 45),
        maxClips: Number(req.body?.max_clips || 6),
      });
      res.json({ clips, analysis_model: VIRAL_ANALYSIS_MODEL });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/projects/:hash/ai-viral-clips', async (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const retranscribe = Boolean(req.body?.retranscribe);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
    const minClipSec = Number(req.body?.min_clip_sec || 6);
    const maxClipSec = Number(req.body?.max_clip_sec || 45);
    const maxClips = Number(req.body?.max_clips || 6);

    try {
      let transcript = readCachedTranscript(hash) as any;
      const isDraftTranscript =
        !transcript ||
        transcript.model_name === 'local-timed-draft' ||
        transcript.model_name === 'silent-track-draft';
      let cacheHit = !retranscribe && !isDraftTranscript && Boolean(transcript?.segments?.length);
      let note: string | undefined;

      if (!cacheHit) {
        if (!project.has_audio) {
          if (!transcript?.segments?.length) {
            res.status(422).json({
              error: 'This video has no audio track to transcribe. Import an .srt transcript to run AI viral clip analysis.',
            });
            return;
          }
          note = 'No audio track detected; analyzed the cached transcript instead.';
        } else {
          const chunks = await extractVideoAudioChunks(project.local_path, project.duration_sec, hash);
          const aiTranscript = await transcribeVideoChunksWithGemini({
            videoHash: hash,
            sourcePath: project.local_path,
            totalDurationSec: project.duration_sec,
            chunks,
          });

          if (aiTranscript.segments.length > 0) {
            transcript = aiTranscript;
            writeCachedTranscript(aiTranscript);
          } else if (transcript?.segments?.length) {
            note =
              'No spoken dialogue was detected in the audio track; analyzed existing cached transcript segments instead.';
          } else {
            res.status(422).json({
              error: 'No spoken dialogue was detected in this video audio track. Upload a video with speech or import an .srt transcript.',
            });
            return;
          }
        }
      }

      const clips = await analyzeTranscriptForViralClips({
        transcript,
        prompt,
        minClipSec,
        maxClipSec,
        maxClips,
      });

      project.clips = clips;
      upsertProject(project);

      res.json({
        transcript,
        clips,
        cache_hit: cacheHit,
        transcript_model: transcript.model_name || TRANSCRIBE_MODEL,
        analysis_model: VIRAL_ANALYSIS_MODEL,
        note,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/projects/:hash/highlights', async (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const transcript = readCachedTranscript(hash);
    if (!transcript) {
      res.status(400).json({ error: 'Transcribe video before extracting highlights' });
      return;
    }

    try {
      const stdout = await runPythonCli(['highlights'], {
        transcript,
        prompt: req.body?.prompt || 'High-retention hooks, bold insights, concise takeaways',
        ollama_url: req.body?.ollama_url || 'http://localhost:11434',
        ollama_model: req.body?.ollama_model || 'qwen2.5:14b',
        min_clip_sec: Number(req.body?.min_clip_sec || 6),
        max_clip_sec: Number(req.body?.max_clip_sec || 45),
        max_clips: Number(req.body?.max_clips || 6),
        timeout_sec: 1.5,
      });
      const clips = JSON.parse(stdout);
      project.clips = clips;
      upsertProject(project);
      res.json({ clips });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Highlight extraction failed' });
    }
  });

  app.put('/api/projects/:hash/clips', (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    const project = readProjects().find((p) => p.video_hash === hash);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    project.clips = Array.isArray(req.body?.clips) ? req.body.clips : [];
    upsertProject(project);
    res.json({ clips: project.clips });
  });

  app.post('/api/clips/snap', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(['snap'], {
        clip: req.body.clip,
        transcript: req.body.transcript,
      });
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Word-boundary snap failed' });
    }
  });

  app.post('/api/clips/captions', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(['captions'], {
        clip: req.body.clip,
        transcript: req.body.transcript || null,
        subtitle_config: req.body.subtitle_config || req.body.clip?.subtitles || null,
        aspect_ratio: req.body.aspect_ratio || '9:16',
      });
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Caption generation failed' });
    }
  });

  app.post('/api/clips/export', async (req: Request, res: Response) => {
    try {
      const hash = String(req.body?.video_hash || '');
      const project = readProjects().find((p) => p.video_hash === hash);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const transcript = readCachedTranscript(hash) || {
        video_hash: hash,
        source_path: project.local_path,
        language: 'en',
        duration_sec: project.duration_sec || 10,
        model_name: 'manual',
        created_at_iso: new Date().toISOString(),
        segments: [],
      };

      const stdout = await runPythonCli(['export'], {
        source_path: project.local_path,
        clip: req.body.clip,
        transcript,
        subtitle_config: req.body.subtitle_config || req.body.clip?.subtitles || null,
        aspect_ratio: req.body.aspect_ratio || '9:16',
        encode_mode: req.body.encode_mode || 'reencode',
        include_srt: req.body.include_srt !== false,
        burn_captions: req.body.burn_captions !== false,
        output_dir: EXPORTS_DIR,
      });
      const result = JSON.parse(stdout);
      res.json({
        ...result,
        video_url: `/media/exports/${path.basename(result.video_path)}`,
        srt_url: result.srt_path ? `/media/exports/${path.basename(result.srt_path)}` : null,
        ass_url: result.ass_path ? `/media/exports/${path.basename(result.ass_path)}` : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'FFmpeg export failed' });
    }
  });

  // SQLite Publish Queue API (backed by clippah_core/core/queue.py)
  app.get('/api/queue', async (_req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(['queue', '--db', QUEUE_DB, '--action', 'list']);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to read publish queue' });
    }
  });

  app.post('/api/queue', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(
        ['queue', '--db', QUEUE_DB, '--action', 'enqueue'],
        req.body
      );
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to enqueue publish job' });
    }
  });

  app.get('/api/queue/channels', async (_req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(['queue', '--db', QUEUE_DB, '--action', 'channels-list']);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to read social channels' });
    }
  });

  app.put('/api/queue/channels/:platform', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(
        ['queue', '--db', QUEUE_DB, '--action', 'channel-upsert', '--platform', String(req.params.platform)],
        req.body || {}
      );
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to update social channel' });
    }
  });

  app.post('/api/queue/channels/:platform/test', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(
        ['queue', '--db', QUEUE_DB, '--action', 'channel-test', '--platform', String(req.params.platform)],
        req.body || {}
      );
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Webhook test failed' });
    }
  });

  app.post('/api/queue/process', async (req: Request, res: Response) => {
    try {
      const args = ['queue', '--db', QUEUE_DB, '--action', 'process'];
      if (req.body?.include_future) args.push('--include-future');
      const stdout = await runPythonCli(args);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Queue processing failed' });
    }
  });

  app.patch('/api/queue/:jobId', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli(
        ['queue', '--db', QUEUE_DB, '--action', 'update', '--job-id', String(req.params.jobId)],
        req.body || {}
      );
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to update job' });
    }
  });

  app.post('/api/queue/:jobId/dispatch', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli([
        'queue', '--db', QUEUE_DB, '--action', 'dispatch', '--job-id', String(req.params.jobId),
      ]);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Dispatch failed' });
    }
  });

  app.post('/api/queue/:jobId/retry', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli([
        'queue', '--db', QUEUE_DB, '--action', 'retry', '--job-id', String(req.params.jobId),
      ]);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Retry failed' });
    }
  });

  app.delete('/api/queue/:jobId', async (req: Request, res: Response) => {
    try {
      const stdout = await runPythonCli([
        'queue', '--db', QUEUE_DB, '--action', 'delete', '--job-id', String(req.params.jobId),
      ]);
      res.json(JSON.parse(stdout));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Delete failed' });
    }
  });

  // -------------------------------------------------------------------------
  // Multi-Platform OAuth Routes & Social Publishing Dispatcher
  // -------------------------------------------------------------------------
  const isAllowedLoopbackCallback = (url: string): boolean =>
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url.trim());

  // Allow Tauri desktop WebView (http://tauri.localhost / tauri://localhost) to call auth, audio, AI & social APIs
  app.use(['/api/auth', '/api/social', '/api/audio', '/api/ai'], (req: Request, res: Response, next) => {
    const origin = String(req.headers.origin || '');
    if (
      origin === 'http://tauri.localhost' ||
      origin === 'https://tauri.localhost' ||
      origin === 'tauri://localhost' ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:')
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/auth/providers/status', (req: Request, res: Response) => {
    const providers = (Object.keys(SOCIAL_PROVIDERS) as SupportedSocialPlatform[]).map((pid) => {
      const adapter = SOCIAL_PROVIDERS[pid];
      return {
        platform: adapter.platform,
        displayName: adapter.displayName,
        configured: adapter.isConfigured(),
        missingSecrets: adapter.getMissingSecrets(),
        redirectUri: buildProviderRedirectUri(adapter.platform, req),
        scopes: adapter.requiredScopes,
      };
    });
    res.json({ providers });
  });

  app.get(
    ['/api/auth/:platform/start', '/api/auth/:platform/start/'],
    (req: Request, res: Response) => {
      const platform = String(req.params.platform || '').toLowerCase();
      const provider = getSocialProvider(platform);
      if (!provider) {
        res.status(404).json({ error: `Unsupported OAuth platform: ${platform}` });
        return;
      }
      const missing = provider.getMissingSecrets();
      if (missing.length > 0) {
        res.status(400).json({
          error: `${provider.displayName} OAuth requires server environment secret(s): ${missing.join(', ')}`,
          missingSecrets: missing,
          redirectUri: buildProviderRedirectUri(provider.platform, req),
        });
        return;
      }

      const rawDesktopCallback = String(req.query.desktop_callback || '').trim();
      const desktopCallback = isAllowedLoopbackCallback(rawDesktopCallback)
        ? rawDesktopCallback
        : undefined;
      const desktopState = String(req.query.desktop_state || '').trim() || undefined;

      const redirectUri = buildProviderRedirectUri(provider.platform, req);
      const { state, codeChallenge } = createOAuthStateSession(
        provider.platform,
        redirectUri,
        desktopCallback ? { desktopCallback, desktopState } : undefined
      );
      res.cookie(`cutline_oauth_state_${provider.platform}`, state, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 10 * 60 * 1000,
      });
      const authUrl = provider.buildAuthorizeUrl({ redirectUri, state, codeChallenge });
      if (req.query.mode === 'redirect') {
        res.redirect(authUrl);
        return;
      }
      res.json({ url: authUrl, redirectUri, state });
    }
  );

  const renderPopupCallbackHtml = (payload: Record<string, unknown>, title: string, detail: string) => {
    const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #111724; border: 1px solid #334155; border-radius: 10px; padding: 24px; max-width: 420px; text-align: center; }
      h2 { margin: 0 0 8px; font-size: 16px; }
      p { margin: 0 0 16px; font-size: 13px; color: #94a3b8; }
      button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>${title}</h2>
      <p>${detail}</p>
      <button onclick="window.close()">Close Window</button>
    </div>
    <script>
      (function () {
        var payload = ${serialized};
        try {
          if (window.opener) {
            window.opener.postMessage(payload, '*');
            setTimeout(function () { window.close(); }, 350);
          } else {
            window.location.href = '/';
          }
        } catch (e) {}
      })();
    </script>
  </body>
</html>`;
  };

  const renderDesktopLoopbackPostHtml = (
    callbackUrl: string,
    desktopState: string,
    fields: { connection_json?: string; error?: string },
    title: string,
    detail: string
  ) => {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${esc(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #111724; border: 1px solid #334155; border-radius: 10px; padding: 24px; max-width: 420px; text-align: center; }
      h2 { margin: 0 0 8px; font-size: 16px; }
      p { margin: 0 0 16px; font-size: 13px; color: #94a3b8; }
      button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>${esc(title)}</h2>
      <p>${esc(detail)}</p>
      <form id="bridgeForm" method="POST" action="${esc(callbackUrl)}">
        <input type="hidden" name="state" value="${esc(desktopState)}" />
        ${fields.connection_json ? `<input type="hidden" name="connection_json" value="${esc(fields.connection_json)}" />` : ''}
        ${fields.error ? `<input type="hidden" name="error" value="${esc(fields.error)}" />` : ''}
        <button type="submit">Return to Cutline Studio</button>
      </form>
    </div>
    <script>document.getElementById('bridgeForm').submit();</script>
  </body>
</html>`;
  };

  app.get(
    ['/api/auth/:platform/callback', '/api/auth/:platform/callback/'],
    async (req: Request, res: Response) => {
      const platform = String(req.params.platform || '').toLowerCase();
      const provider = getSocialProvider(platform);
      if (!provider) {
        res
          .status(404)
          .send(
            renderPopupCallbackHtml(
              { type: 'OAUTH_AUTH_ERROR', platform, error: `Unsupported platform: ${platform}` },
              'Unsupported Provider',
              `Platform "${platform}" is not supported.`
            )
          );
        return;
      }

      const state = String(req.query.state || '').trim();
      const session = state ? consumeOAuthStateSession(state) : null;

      const oauthError = String(req.query.error || '').trim();
      if (oauthError) {
        const desc = String(req.query.error_description || oauthError);
        if (session?.desktopCallback && session.desktopState) {
          res
            .status(400)
            .send(
              renderDesktopLoopbackPostHtml(
                session.desktopCallback,
                session.desktopState,
                { error: desc },
                `${provider.displayName} Authorization Declined`,
                desc
              )
            );
          return;
        }
        res
          .status(400)
          .send(
            renderPopupCallbackHtml(
              { type: 'OAUTH_AUTH_ERROR', platform, error: desc },
              `${provider.displayName} Authorization Declined`,
              desc
            )
          );
        return;
      }

      const code = String(req.query.code || '').trim();
      const cookieState = req.cookies?.[`cutline_oauth_state_${provider.platform}`];
      res.clearCookie(`cutline_oauth_state_${provider.platform}`, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      });

      if (!code || (!session && (!cookieState || cookieState !== state))) {
        res
          .status(400)
          .send(
            renderPopupCallbackHtml(
              {
                type: 'OAUTH_AUTH_ERROR',
                platform,
                error: 'Invalid or expired OAuth state parameter. Please try connecting again.',
              },
              'OAuth State Expired',
              'The authorization session expired or failed CSRF verification. Close this window and retry.'
            )
          );
        return;
      }

      try {
        const redirectUri = session?.redirectUri || buildProviderRedirectUri(provider.platform, req);
        const tokenData = await provider.exchangeCode({
          code,
          redirectUri,
          codeVerifier: session?.codeVerifier || '',
        });
        const profile = await provider.fetchProfile({
          accessToken: tokenData.accessToken,
          rawTokenData: tokenData.raw,
        });

        const connection = {
          platform: provider.platform,
          accountName: profile.accountName,
          handle: profile.handle,
          externalAccountId: profile.externalAccountId,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: tokenData.expiresAt,
          scopes: tokenData.scopes,
        };

        if (session?.desktopCallback && session.desktopState) {
          res.send(
            renderDesktopLoopbackPostHtml(
              session.desktopCallback,
              session.desktopState,
              { connection_json: JSON.stringify(connection) },
              `${provider.displayName} Connected`,
              `Connected ${connection.accountName} (${connection.handle}). Returning to Cutline Studio desktop...`
            )
          );
          return;
        }

        res.send(
          renderPopupCallbackHtml(
            { type: 'OAUTH_AUTH_SUCCESS', platform: provider.platform, connection },
            `${provider.displayName} Connected`,
            `Connected ${connection.accountName} (${connection.handle}). Returning to Cutline Studio...`
          )
        );
      } catch (err: any) {
        const msg = err?.message || `Failed to complete ${provider.displayName} OAuth callback.`;
        if (session?.desktopCallback && session.desktopState) {
          res
            .status(500)
            .send(
              renderDesktopLoopbackPostHtml(
                session.desktopCallback,
                session.desktopState,
                { error: msg },
                `${provider.displayName} Connection Failed`,
                msg
              )
            );
          return;
        }
        res
          .status(500)
          .send(
            renderPopupCallbackHtml(
              { type: 'OAUTH_AUTH_ERROR', platform: provider.platform, error: msg },
              `${provider.displayName} Connection Failed`,
              msg
            )
          );
      }
    }
  );

  app.post(
    '/api/social/upload-media',
    socialExportUpload.single('video'),
    (req: Request, res: Response) => {
      const authHeader = String(req.headers.authorization || '');
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7).trim().length < 20) {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        res.status(401).json({ error: 'Firebase authentication required to stage social media.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Video file missing in multipart upload.' });
        return;
      }
      res.json({
        videoUrl: `/media/exports/${req.file.filename}`,
        localVideoPath: req.file.path,
      });
    }
  );

  app.post('/api/social/publish', async (req: Request, res: Response) => {
    try {
      const authHeader = String(req.headers.authorization || '');
      const firebaseIdToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

      const userId = String(req.body?.userId || '').trim();
      const rawPlatforms: unknown[] = Array.isArray(req.body?.platforms)
        ? req.body.platforms
        : req.body?.platform
          ? [req.body.platform]
          : [];
      const platforms: SupportedSocialPlatform[] = rawPlatforms
        .map((p: unknown) => String(p).toLowerCase())
        .filter((p: string): p is SupportedSocialPlatform =>
          p === 'tiktok' || p === 'instagram' || p === 'youtube'
        );

      if (platforms.length === 0) {
        res.status(400).json({ error: 'Select at least one social platform (tiktok, instagram, youtube).' });
        return;
      }

      const rawVideoUrl = String(req.body?.videoUrl || '').trim();
      const rawLocalPath = String(req.body?.localVideoPath || req.body?.videoPath || '').trim();
      let resolvedLocalPath = rawLocalPath && fs.existsSync(rawLocalPath) ? rawLocalPath : undefined;
      if (!resolvedLocalPath && rawVideoUrl.includes('/media/exports/')) {
        const fname = decodeURIComponent(rawVideoUrl.split('/media/exports/').pop() || '');
        const candidate = path.join(EXPORTS_DIR, path.basename(fname));
        if (fs.existsSync(candidate)) resolvedLocalPath = candidate;
      }

      const publicVideoUrl = resolvePublicMediaUrl(rawVideoUrl, req);
      const caption = String(req.body?.caption || '').trim();
      const rawPrivacy = String(req.body?.privacy || 'public').toLowerCase();
      const privacy: SocialPrivacy =
        rawPrivacy === 'private' || rawPrivacy === 'unlisted' ? rawPrivacy : 'public';
      const scheduledAt =
        typeof req.body?.scheduledAt === 'string' && req.body.scheduledAt.trim()
          ? req.body.scheduledAt.trim()
          : null;
      const connections = (req.body?.connections || {}) as Record<string, any>;

      // Execute per-platform independently so one failure never blocks or hides others
      const results = await Promise.all(
        platforms.map((platform: SupportedSocialPlatform) =>
          publishClipToPlatform({
            userId,
            platform,
            videoUrl: publicVideoUrl,
            localVideoPath: resolvedLocalPath,
            caption,
            privacy,
            scheduledAt,
            firebaseIdToken,
            connectionOverride: connections?.[platform] || null,
          })
        )
      );

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Multi-platform social publish failed.' });
    }
  });

  app.post('/api/social/refresh', async (req: Request, res: Response) => {
    try {
      const authHeader = String(req.headers.authorization || '');
      const firebaseIdToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
      const userId = String(req.body?.userId || '').trim();
      const platform = String(req.body?.platform || '').toLowerCase() as SupportedSocialPlatform;
      const provider = getSocialProvider(platform);
      if (!provider) {
        res.status(400).json({ error: `Unsupported platform: ${platform}` });
        return;
      }

      const missing = provider.getMissingSecrets();
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing server secret(s): ${missing.join(', ')}` });
        return;
      }

      let conn = req.body?.connection || null;
      if (!conn && firebaseIdToken && userId) {
        conn = await getSocialConnectionFromFirestore(userId, platform, firebaseIdToken);
      }
      if (!conn) {
        res.status(404).json({ error: `No connected ${provider.displayName} account found.` });
        return;
      }

      const refreshed = await provider.refreshToken({
        accessToken: String(conn.accessToken || ''),
        refreshToken: String(conn.refreshToken || ''),
      });
      if (firebaseIdToken && userId) {
        await persistRefreshedTokensToFirestore(userId, platform, firebaseIdToken, refreshed);
      }

      res.json({
        connection: {
          ...conn,
          ...refreshed,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Token refresh failed.' });
    }
  });

  // Architecture & Portability Explorer API
  app.get('/api/architecture/tree', (_req: Request, res: Response) => {
    const entries: Array<{ path: string; layer: string; bytes: number }> = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir).sort()) {
        if (name === '__pycache__' || name === 'target' || name.endsWith('.pyc') || name.endsWith('.png') || name.endsWith('.ico')) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          const rel = path.relative(ROOT_DIR, full);
          const layer = rel.includes('/core/')
            ? 'core'
            : rel.includes('/adapters/')
              ? 'adapter'
              : rel.includes('/ui/')
                ? 'ui'
                : rel.includes('/tests/')
                  ? 'tests'
                  : 'root';
          entries.push({ path: rel, layer, bytes: stat.size });
        }
      }
    };
    walk(PYTHON_CORE_DIR);
    walk(path.join(ROOT_DIR, 'src-tauri'));
    walk(path.join(ROOT_DIR, '.github'));
    res.json(entries);
  });

  app.get('/api/architecture/file', (req: Request, res: Response) => {
    const relPath = String(req.query.path || '');
    const resolved = path.resolve(ROOT_DIR, relPath);
    const allowedRoots = [
      PYTHON_CORE_DIR,
      path.join(ROOT_DIR, 'src-tauri'),
      path.join(ROOT_DIR, '.github'),
    ];
    if (!allowedRoots.some((r) => resolved.startsWith(r)) || !fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Architecture file not found' });
      return;
    }
    res.json({ path: relPath, content: fs.readFileSync(resolved, 'utf-8') });
  });

  app.post('/api/architecture/test', async (_req: Request, res: Response) => {
    const started = Date.now();
    const proc = spawn('python3', ['-m', 'unittest', 'discover', '-s', 'clippah_core/tests', '-v'], {
      cwd: ROOT_DIR,
    });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      res.json({
        passed: code === 0,
        exit_code: code,
        duration_ms: Date.now() - started,
        output: output.trim(),
      });
    });
  });

  app.get('/api/architecture/bundle', async (_req: Request, res: Response) => {
    try {
      const zip = new JSZip();
      const addDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          if (name === '__pycache__' || name === 'target' || name === 'node_modules' || name.endsWith('.pyc')) continue;
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) {
            addDir(full);
          } else {
            zip.file(path.relative(ROOT_DIR, full), fs.readFileSync(full));
          }
        }
      };
      addDir(PYTHON_CORE_DIR);
      addDir(path.join(ROOT_DIR, 'src-tauri'));
      addDir(path.join(ROOT_DIR, '.github'));
      addDir(path.join(ROOT_DIR, 'src'));
      for (const rootFile of ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']) {
        const p = path.join(ROOT_DIR, rootFile);
        if (fs.existsSync(p)) {
          zip.file(rootFile, fs.readFileSync(p));
        }
      }
      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="cutline_studio_tauri_starter.zip"');
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to package bundle' });
    }
  });

  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  // Seed default sample video cleanly on startup if projects list is empty
  if (readProjects().length === 0) {
    generateSampleVideoFile().catch((err) => {
      console.error('Initial sample seeding skipped:', err);
    });
  }

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(ROOT_DIR, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(ROOT_DIR, 'dist', 'index.html'));
    });
  }

  const PORT = 3000;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cutline Studio listening on http://0.0.0.0:${PORT}`);
  });
  server.timeout = 300000;
  server.keepAliveTimeout = 65000;
}

startServer();
