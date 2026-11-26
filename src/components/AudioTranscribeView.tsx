import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  FileAudio,
  FileText,
  Film,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiFetch, isTauriRuntime, readJsonResponse } from '../lib/api';
import type { ProjectRecord, TranscriptSegment } from '../types';

export interface SaveTranscriptPayload {
  text: string;
  segments?: TranscriptSegment[];
  runViralAnalysis?: boolean;
}

interface AudioTranscribeViewProps {
  activeProject: ProjectRecord | null;
  onUseAsHighlightPrompt: (text: string) => void;
  onSaveAsProjectTranscript: (payload: SaveTranscriptPayload) => Promise<void>;
}

interface TranscriptionTake {
  id: string;
  createdAtIso: string;
  sourceLabel: string;
  durationSec: number;
  mimeType: string;
  audioUrl: string;
  text: string;
  segments: TranscriptSegment[];
  srt: string;
}

const TRANSCRIPTION_PRESETS = [
  {
    label: 'Timestamped video sync',
    prompt:
      'Transcribe all spoken words verbatim with accurate sentence boundaries so timestamps align cleanly with the matching video.',
  },
  {
    label: 'Accurate verbatim',
    prompt: 'Transcribe this spoken audio accurately into clean text with proper punctuation.',
  },
  {
    label: 'Clean & polished',
    prompt:
      'Transcribe this spoken audio into clean, readable prose, removing filler words while preserving exact meaning.',
  },
];

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

function formatTimer(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBracketTs(seconds: number): string {
  return `[${formatTimer(seconds)}]`;
}

function formatSrtTs(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(msTotal / 3_600_000);
  const mins = Math.floor((msTotal % 3_600_000) / 60_000);
  const secs = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function probeBrowserAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    const done = (val: number) => {
      audio.src = '';
      resolve(Number.isFinite(val) && val > 0 ? val : 0);
    };
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

export const AudioTranscribeView: React.FC<AudioTranscribeViewProps> = ({
  activeProject,
  onUseAsHighlightPrompt,
  onSaveAsProjectTranscript,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [autoTranscribeOnStop, setAutoTranscribeOnStop] = useState(true);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [instruction, setInstruction] = useState(TRANSCRIPTION_PRESETS[0].prompt);
  const [resultViewMode, setResultViewMode] = useState<'timed' | 'raw'>('timed');

  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioMimeType, setAudioMimeType] = useState<string>('audio/webm');
  const [audioLabel, setAudioLabel] = useState<string>('Microphone recording');
  const [audioDurationSec, setAudioDurationSec] = useState<number>(0);

  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSavingToProject, setIsSavingToProject] = useState(false);
  const [isSyncingAndAnalyzing, setIsSyncingAndAnalyzing] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');
  const [timedSegments, setTimedSegments] = useState<TranscriptSegment[]>([]);
  const [srtOutput, setSrtOutput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedSrt, setCopiedSrt] = useState(false);
  const [takes, setTakes] = useState<TranscriptionTake[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const recordingStartMsRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  const stopVisualizerAndStream = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopVisualizerAndStream();
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const drawIdleWaveform = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const midY = canvas.height / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(canvas.width, midY);
    ctx.stroke();
  };

  useEffect(() => {
    if (!isRecording) {
      drawIdleWaveform();
    }
  }, [isRecording]);

  const rebuildFormattedFromSegments = (segs: TranscriptSegment[]) => {
    const nextText = segs.map((s) => `${formatBracketTs(s.start_sec)} ${s.text.trim()}`).join('\n');
    const nextSrt = segs
      .map(
        (s, idx) =>
          `${idx + 1}\n${formatSrtTs(s.start_sec)} --> ${formatSrtTs(Math.max(s.start_sec + 0.3, s.end_sec))}\n${s.text.trim()}`
      )
      .join('\n\n');
    setTranscriptText(nextText);
    setSrtOutput(nextSrt);
  };

  const runTranscription = async (
    targetBlob: Blob,
    mimeType: string,
    sourceLabel: string,
    durationSec: number,
    previewUrl: string
  ) => {
    setIsTranscribing(true);
    setErrorMsg(null);
    try {
      const formData = new FormData();
      const ext = mimeType.includes('mp4')
        ? 'm4a'
        : mimeType.includes('ogg')
          ? 'ogg'
          : mimeType.includes('wav')
            ? 'wav'
            : mimeType.includes('mp3') || mimeType.includes('mpeg')
              ? 'mp3'
              : 'webm';
      const safeFilename = sourceLabel.includes('.') ? sourceLabel : `recording.${ext}`;
      formData.append('audio', targetBlob, safeFilename);
      formData.append('mimeType', mimeType);
      formData.append('prompt', instruction);
      formData.append('timestamps', String(includeTimestamps));
      if (durationSec > 0) {
        formData.append('durationSec', String(durationSec));
      }

      const res = await apiFetch('/api/audio/transcribe', {
        method: 'POST',
        body: formData,
      });
      if (isTauriRuntime && res.status === 404) {
        throw new Error(
          'Your local desktop sidecar binary does not include /api/audio/transcribe yet. Rebuild the desktop bundle or use the web app for audio transcription.'
        );
      }
      const data = await readJsonResponse<{
        text: string;
        model: string;
        mimeType: string;
        timestamped?: boolean;
        duration_sec?: number;
        segments?: TranscriptSegment[];
        srt?: string;
      }>(res);

      const cleanText = (data.text || '').trim();
      const returnedSegs = Array.isArray(data.segments) ? data.segments : [];
      const finalDur = Number(data.duration_sec) || durationSec;
      if (finalDur > 0 && durationSec === 0) {
        setAudioDurationSec(finalDur);
      }
      setTranscriptText(cleanText);
      setTimedSegments(returnedSegs);
      setSrtOutput((data.srt || '').trim());
      if (returnedSegs.length > 0) {
        setResultViewMode('timed');
      } else {
        setResultViewMode('raw');
      }

      if (cleanText) {
        const take: TranscriptionTake = {
          id: `take_${Date.now()}`,
          createdAtIso: new Date().toISOString(),
          sourceLabel,
          durationSec: finalDur,
          mimeType: data.mimeType || mimeType,
          audioUrl: previewUrl,
          text: cleanText,
          segments: returnedSegs,
          srt: (data.srt || '').trim(),
        };
        setTakes((prev) => [take, ...prev].slice(0, 12));
      } else {
        setErrorMsg('No speech was detected in the audio. Try another recording or audio file.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Audio transcription failed.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleStartRecording = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setErrorMsg(
        'Microphone recording is not supported in this browser environment. You can upload an MP3 or audio file instead.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      chunksRef.current = [];

      const preferredMime = pickSupportedRecorderMime();
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const audioCtx = new AudioCtx();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const renderFrame = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          analyser.getByteFrequencyData(dataArray);
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const barCount = 48;
          const step = Math.max(1, Math.floor(bufferLength / barCount));
          const barWidth = Math.max(2, canvas.width / barCount - 3);
          const midY = canvas.height / 2;

          for (let i = 0; i < barCount; i++) {
            const value = dataArray[i * step] || 0;
            const barHeight = Math.max(4, (value / 255) * (canvas.height - 8));
            const x = i * (barWidth + 3);
            ctx.fillStyle = value > 130 ? '#60a5fa' : '#3b82f6';
            ctx.fillRect(x, midY - barHeight / 2, barWidth, barHeight);
          }

          rafRef.current = requestAnimationFrame(renderFrame);
        };
        rafRef.current = requestAnimationFrame(renderFrame);
      }

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        const elapsed = Math.max(0.5, (Date.now() - recordingStartMsRef.current) / 1000);
        const finalMime = recorder.mimeType || preferredMime || 'audio/webm';
        const recordedBlob = new Blob(chunksRef.current, { type: finalMime });
        const previewUrl = URL.createObjectURL(recordedBlob);
        objectUrlsRef.current.push(previewUrl);

        stopVisualizerAndStream();
        setIsRecording(false);
        setAudioBlob(recordedBlob);
        setAudioUrl(previewUrl);
        setAudioMimeType(finalMime);
        setAudioLabel('Microphone recording');
        setAudioDurationSec(elapsed);

        if (autoTranscribeOnStop && recordedBlob.size > 0) {
          await runTranscription(recordedBlob, finalMime, 'Microphone recording', elapsed, previewUrl);
        }
      };

      recordingStartMsRef.current = Date.now();
      setElapsedSec(0);
      setIsRecording(true);
      timerIntervalRef.current = window.setInterval(() => {
        setElapsedSec((Date.now() - recordingStartMsRef.current) / 1000);
      }, 200);

      recorder.start(250);
    } catch (err: any) {
      stopVisualizerAndStream();
      setIsRecording(false);
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setErrorMsg(
          'Microphone permission was denied. Allow microphone access in your browser site settings and try again.'
        );
      } else {
        setErrorMsg(err?.message || 'Unable to access microphone.');
      }
    }
  };

  const handleStopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      stopVisualizerAndStream();
      setIsRecording(false);
    }
  };

  const handleAudioFileSelected = async (file: File) => {
    setErrorMsg(null);
    const previewUrl = URL.createObjectURL(file);
    objectUrlsRef.current.push(previewUrl);
    const mime = file.type || (file.name.toLowerCase().endsWith('.mp3') ? 'audio/mp3' : 'audio/mpeg');
    const probedSec = await probeBrowserAudioDuration(previewUrl);

    setAudioBlob(file);
    setAudioUrl(previewUrl);
    setAudioMimeType(mime);
    setAudioLabel(file.name);
    setAudioDurationSec(probedSec);

    if (autoTranscribeOnStop) {
      await runTranscription(file, mime, file.name, probedSec, previewUrl);
    }
  };

  const handleCopy = async () => {
    if (!transcriptText.trim()) return;
    await navigator.clipboard.writeText(transcriptText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleCopySrt = async () => {
    if (!srtOutput.trim()) return;
    await navigator.clipboard.writeText(srtOutput);
    setCopiedSrt(true);
    window.setTimeout(() => setCopiedSrt(false), 1800);
  };

  const handleReset = () => {
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscriptText('');
    setTimedSegments([]);
    setSrtOutput('');
    setElapsedSec(0);
    setAudioDurationSec(0);
    setErrorMsg(null);
  };

  const handleSeekAudioPreview = (sec: number) => {
    const el = audioPreviewRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    el.play().catch(() => {});
  };

  const handleSegmentTextEdit = (segId: number, nextText: string) => {
    const nextSegs = timedSegments.map((s) =>
      s.id === segId ? { ...s, text: nextText } : s
    );
    setTimedSegments(nextSegs);
    rebuildFormattedFromSegments(nextSegs);
  };

  const durationDeltaSec =
    activeProject && audioDurationSec > 0
      ? Math.abs(activeProject.duration_sec - audioDurationSec)
      : null;

  return (
    <div className="space-y-5">
      {/* Header Panel */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-white">
              Transcribe Audio &amp; Sync Timestamps to Video
            </h2>
            <p className="text-xs text-slate-400 max-w-2xl">
              Upload an MP3/audio track matching your video (such as a YouTube MP3 download) or record from your microphone. Gemini transcribes every sentence with exact{' '}
              <span className="font-mono text-slate-300">[MM:SS]</span> timestamps so audio, transcript, and video clips stay locked together.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={includeTimestamps}
                onChange={(e) => setIncludeTimestamps(e.target.checked)}
                className="rounded border-slate-700 bg-[#0B0F17] text-blue-500 focus:ring-0"
              />
              <Clock className="w-3.5 h-3.5 text-blue-400" />
              Exact timestamps ([MM:SS])
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoTranscribeOnStop}
                onChange={(e) => setAutoTranscribeOnStop(e.target.checked)}
                className="rounded border-slate-700 bg-[#0B0F17] text-blue-500 focus:ring-0"
              />
              Auto-transcribe on stop/upload
            </label>
          </div>
        </div>

        {/* Live Microphone Recorder + Audio Upload */}
        <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {!isRecording ? (
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={handleStartRecording}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap"
                >
                  <Mic className="w-4 h-4" />
                  Start Microphone Recording
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopRecording}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded transition-colors whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  Stop Recording
                </button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac"
                className="sr-only"
                onClick={(e) => {
                  e.currentTarget.value = '';
                }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleAudioFileSelected(file);
                }}
              />
              <button
                type="button"
                disabled={isRecording || isTranscribing}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload Audio / MP3
              </button>

              {audioBlob && !isRecording && (
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={handleReset}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-transparent hover:bg-slate-800/70 disabled:opacity-40 text-slate-300 border border-slate-800 rounded transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {activeProject && audioDurationSec > 0 && durationDeltaSec !== null && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono tabular-nums ${
                    durationDeltaSec <= 3
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  }`}
                >
                  <Film className="w-3 h-3" />
                  {durationDeltaSec <= 3
                    ? `Matches video (${formatTimer(activeProject.duration_sec)})`
                    : `Audio ${formatTimer(audioDurationSec)} · Video ${formatTimer(activeProject.duration_sec)}`}
                </span>
              )}
              {isRecording && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400">
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                  Recording
                </span>
              )}
              <span className="font-mono tabular-nums text-sm font-semibold text-slate-200">
                {formatTimer(isRecording ? elapsedSec : audioDurationSec)}
              </span>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={720}
            height={56}
            className="w-full h-14 rounded bg-[#0E1420] border border-slate-800/80"
          />

          {/* Instruction Presets */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-[11px] font-medium text-slate-400">
                Transcription Guidance
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {TRANSCRIPTION_PRESETS.map((preset) => {
                  const selected = instruction === preset.prompt;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setInstruction(preset.prompt)}
                      className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                        selected
                          ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                          : 'bg-[#111724] border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <input
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Optional transcription instruction (e.g., speaker names, terminology, or punctuation style)..."
              className="w-full bg-[#111724] border border-slate-800 focus:border-blue-500 rounded px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none"
            />
          </div>

          {/* Uploaded/Recorded Audio Preview + Manual Transcribe Trigger */}
          {audioUrl && !isRecording && (
            <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-[260px]">
                <FileAudio className="w-4 h-4 text-blue-400 shrink-0" />
                <div className="text-xs text-slate-300 truncate max-w-[200px]" title={audioLabel}>
                  {audioLabel}
                </div>
                <audio ref={audioPreviewRef} controls src={audioUrl} className="h-8 flex-1 min-w-[180px]" />
              </div>

              {audioBlob && (
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={() =>
                    runTranscription(
                      audioBlob,
                      audioMimeType,
                      audioLabel,
                      audioDurationSec,
                      audioUrl
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap"
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {includeTimestamps ? 'Transcribing with timestamps...' : 'Transcribing...'}
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      {includeTimestamps ? 'Transcribe with Timestamps' : 'Transcribe Audio'}
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        {errorMsg && (
          <div className="px-4 py-2.5 rounded-md border bg-rose-950/35 border-rose-500/40 text-xs text-rose-200 flex items-center justify-between gap-3">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-rose-300 hover:text-white shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Transcript Result + Video Sync Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 bg-[#111724] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-semibold text-slate-100">Transcribed Output</h3>
              {timedSegments.length > 0 && (
                <div className="flex items-center gap-1 p-0.5 bg-[#0B0F17] border border-slate-800 rounded">
                  <button
                    type="button"
                    onClick={() => setResultViewMode('timed')}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                      resultViewMode === 'timed'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Timed ({timedSegments.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultViewMode('raw')}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                      resultViewMode === 'raw'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Raw Text
                  </button>
                </div>
              )}
              {isTranscribing && (
                <span className="inline-flex items-center gap-1.5 text-xs text-blue-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Aligning audio timestamps...
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!transcriptText.trim()}
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 disabled:opacity-40 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy Text'}
              </button>
              {srtOutput.trim() && (
                <button
                  type="button"
                  onClick={handleCopySrt}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap"
                >
                  {copiedSrt ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSrt ? 'Copied SRT' : 'Copy SRT'}
                </button>
              )}
              <button
                type="button"
                disabled={!transcriptText.trim()}
                onClick={() => onUseAsHighlightPrompt(transcriptText.trim())}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Use as Prompt
              </button>
              {activeProject && (
                <>
                  <button
                    type="button"
                    disabled={!transcriptText.trim() || isSavingToProject || isSyncingAndAnalyzing}
                    onClick={async () => {
                      setIsSavingToProject(true);
                      try {
                        await onSaveAsProjectTranscript({
                          text: transcriptText.trim(),
                          segments: resultViewMode === 'timed' && timedSegments.length > 0 ? timedSegments : undefined,
                          runViralAnalysis: false,
                        });
                      } finally {
                        setIsSavingToProject(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap"
                  >
                    <Film className="w-3.5 h-3.5" />
                    {isSavingToProject ? 'Syncing...' : 'Sync to Video'}
                  </button>
                  <button
                    type="button"
                    disabled={!transcriptText.trim() || isSavingToProject || isSyncingAndAnalyzing}
                    onClick={async () => {
                      setIsSyncingAndAnalyzing(true);
                      try {
                        await onSaveAsProjectTranscript({
                          text: transcriptText.trim(),
                          segments: resultViewMode === 'timed' && timedSegments.length > 0 ? timedSegments : undefined,
                          runViralAnalysis: true,
                        });
                      } finally {
                        setIsSyncingAndAnalyzing(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap"
                  >
                    {isSyncingAndAnalyzing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        Sync &amp; Generate Viral Clips
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>

          {resultViewMode === 'timed' && timedSegments.length > 0 ? (
            <div className="bg-[#0B0F17] border border-slate-800 rounded-md p-2.5 space-y-2 max-h-[340px] overflow-y-auto">
              {timedSegments.map((seg) => (
                <div
                  key={seg.id}
                  className="flex items-start gap-2.5 p-2 bg-[#111724] border border-slate-800/80 rounded"
                >
                  <button
                    type="button"
                    onClick={() => handleSeekAudioPreview(seg.start_sec)}
                    title={`Jump audio preview to ${formatTimer(seg.start_sec)}`}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono tabular-nums bg-blue-600/15 hover:bg-blue-600/30 border border-blue-500/35 text-blue-300 rounded shrink-0 transition-colors"
                  >
                    <Play className="w-2.5 h-2.5" />
                    {formatTimer(seg.start_sec)}
                  </button>
                  <input
                    type="text"
                    value={seg.text}
                    onChange={(e) => handleSegmentTextEdit(seg.id, e.target.value)}
                    className="flex-1 bg-transparent border border-transparent focus:border-slate-700 focus:bg-[#0B0F17] rounded px-2 py-1 text-xs text-slate-100 outline-none"
                  />
                  <span className="text-[10px] font-mono tabular-nums text-slate-500 pt-1.5 shrink-0">
                    → {formatTimer(seg.end_sec)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <textarea
              value={transcriptText}
              onChange={(e) => {
                setTranscriptText(e.target.value);
                if (timedSegments.length > 0) {
                  setTimedSegments([]);
                }
              }}
              placeholder="Upload an MP3/audio file or press Start Microphone Recording. Your timestamped [MM:SS] transcription will appear here and can be synced directly to the active video..."
              rows={10}
              className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded-md p-3.5 text-sm leading-relaxed font-mono text-slate-100 placeholder:text-slate-500 outline-none resize-y"
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
            <span>
              {transcriptText.trim()
                ? `${transcriptText.trim().split(/\s+/).length} words · ${timedSegments.length > 0 ? `${timedSegments.length} timed segments` : `${transcriptText.length} chars`}`
                : '0 words'}
            </span>
            {activeProject && (
              <span className="truncate max-w-[360px]">
                Target video: {activeProject.title} ({formatTimer(activeProject.duration_sec)})
              </span>
            )}
          </div>
        </div>

        {/* Recent Takes */}
        <div className="lg:col-span-4 bg-[#111724] border border-slate-800/90 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Session Audio &amp; Takes</h3>
            <span className="text-[11px] font-mono tabular-nums text-slate-400">
              {takes.length}
            </span>
          </div>

          {takes.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-md px-4">
              Completed MP3 uploads and microphone recordings during this session appear here for quick replay and video sync.
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
              {takes.map((take) => (
                <div
                  key={take.id}
                  className="bg-[#0B0F17] border border-slate-800 rounded-md p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-medium text-slate-200 truncate">
                      {take.sourceLabel}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {take.durationSec > 0 && (
                        <span className="font-mono tabular-nums text-slate-400">
                          {formatTimer(take.durationSec)}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setTakes((prev) => prev.filter((item) => item.id !== take.id))}
                        aria-label="Remove recording"
                        className="text-slate-500 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 line-clamp-3 leading-relaxed">
                    {take.text}
                  </p>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setTranscriptText(take.text);
                        setTimedSegments(take.segments);
                        setSrtOutput(take.srt);
                        setAudioUrl(take.audioUrl);
                        setAudioLabel(take.sourceLabel);
                        setAudioDurationSec(take.durationSec);
                        setResultViewMode(take.segments.length > 0 ? 'timed' : 'raw');
                      }}
                      className="text-[11px] font-medium text-blue-400 hover:text-blue-300"
                    >
                      Load into editor
                    </button>
                    <button
                      type="button"
                      onClick={() => onUseAsHighlightPrompt(take.text)}
                      className="text-[11px] font-medium text-slate-300 hover:text-white"
                    >
                      Use as prompt
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
