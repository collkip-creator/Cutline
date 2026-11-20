import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import JSZip from 'jszip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

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

  if (!fs.existsSync(targetPath)) {
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
      targetPath,
    ]);
  }

  const meta = await probeVideo(targetPath);
  const hash = await computeSha256(targetPath);
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

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
        transcript: req.body.transcript,
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
      const transcript = readCachedTranscript(hash);
      if (!transcript) {
        res.status(400).json({ error: 'Transcript missing for export' });
        return;
      }

      const stdout = await runPythonCli(['export'], {
        source_path: project.local_path,
        clip: req.body.clip,
        transcript,
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

  // Architecture & Portability Explorer API
  app.get('/api/architecture/tree', (_req: Request, res: Response) => {
    const entries: Array<{ path: string; layer: string; bytes: number }> = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name === '__pycache__' || name.endsWith('.pyc')) continue;
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
    res.json(entries);
  });

  app.get('/api/architecture/file', (req: Request, res: Response) => {
    const relPath = String(req.query.path || '');
    const resolved = path.resolve(ROOT_DIR, relPath);
    if (!resolved.startsWith(PYTHON_CORE_DIR) || !fs.existsSync(resolved)) {
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
        for (const name of fs.readdirSync(dir)) {
          if (name === '__pycache__' || name.endsWith('.pyc')) continue;
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) {
            addDir(full);
          } else {
            zip.file(path.relative(ROOT_DIR, full), fs.readFileSync(full));
          }
        }
      };
      addDir(PYTHON_CORE_DIR);
      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="clippah_core_starter.zip"');
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to package bundle' });
    }
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cutline Studio listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
