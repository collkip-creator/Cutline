import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Film,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Send,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  AspectRatio,
  ClipCandidate,
  EncodeMode,
  ExportResult,
  ProjectRecord,
  Transcript,
} from '../types';
import { apiUrl } from '../lib/api';

interface ClipPlayerAndTimelineProps {
  project: ProjectRecord;
  transcript: Transcript | null;
  clips: ClipCandidate[];
  activeClip: ClipCandidate | null;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  encodeMode: EncodeMode;
  onEncodeModeChange: (mode: EncodeMode) => void;
  includeSrt: boolean;
  onIncludeSrtChange: (val: boolean) => void;
  burnCaptions: boolean;
  onBurnCaptionsChange: (val: boolean) => void;
  onSelectClip: (clip: ClipCandidate) => void;
  onUpdateClipBounds: (clipId: string, startSec: number, endSec: number) => void;
  onExportClip: () => Promise<void>;
  isExporting: boolean;
  lastExport: ExportResult | null;
  onOpenQueueModal: (clip: ClipCandidate) => void;
}

function formatTimecode(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

export const ClipPlayerAndTimeline: React.FC<ClipPlayerAndTimelineProps> = ({
  project,
  transcript,
  clips,
  activeClip,
  aspectRatio,
  onAspectRatioChange,
  encodeMode,
  onEncodeModeChange,
  includeSrt,
  onIncludeSrtChange,
  burnCaptions,
  onBurnCaptionsChange,
  onSelectClip,
  onUpdateClipBounds,
  onExportClip,
  isExporting,
  lastExport,
  onOpenQueueModal,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [loopClip, setLoopClip] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);

  // Seek player to active clip start when selection changes
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !activeClip) return;
    vid.currentTime = activeClip.start_sec;
    setCurrentTime(activeClip.start_sec);
  }, [activeClip?.id]);

  // Sync playhead and clip looping
  const handleTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const t = vid.currentTime;
    setCurrentTime(t);
    if (loopClip && activeClip && t >= activeClip.end_sec) {
      vid.currentTime = activeClip.start_sec;
      if (isPlaying) {
        vid.play().catch(() => {});
      }
    }
  };

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      if (activeClip && (vid.currentTime < activeClip.start_sec || vid.currentTime >= activeClip.end_sec)) {
        vid.currentTime = activeClip.start_sec;
      }
      vid.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      vid.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = !vid.muted;
    setIsMuted(vid.muted);
  };

  const seekTo = (sec: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    const clamped = Math.max(0, Math.min(project.duration_sec, sec));
    vid.currentTime = clamped;
    setCurrentTime(clamped);
  };

  // Determine live caption text at current playhead
  const activeCaptionLine = useMemo(() => {
    if (!transcript) return '';
    const allWords = transcript.segments.flatMap((s) =>
      s.words.length > 0
        ? s.words
        : [{ word: s.text, start_sec: s.start_sec, end_sec: s.end_sec, confidence: 1 }]
    );
    const windowWords = allWords.filter(
      (w) => currentTime >= w.start_sec - 0.15 && currentTime <= w.end_sec + 1.15
    );
    if (windowWords.length > 0) {
      return windowWords.slice(0, 6).map((w) => w.word).join(' ');
    }
    const seg = transcript.segments.find(
      (s) => currentTime >= s.start_sec && currentTime <= s.end_sec
    );
    return seg?.text || '';
  }, [transcript, currentTime]);

  const showHookOverlay =
    Boolean(activeClip?.caption_hook) &&
    Boolean(activeClip) &&
    currentTime >= (activeClip?.start_sec ?? 0) &&
    currentTime <= (activeClip?.start_sec ?? 0) + 3.5;

  return (
    <div className="flex flex-col gap-4">
      {/* Viewport + Render Options Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-stretch">
        {/* Left: Video Preview Frame */}
        <div className="xl:col-span-7 bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-800/80">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-100 truncate">
                {activeClip ? activeClip.title : project.title}
              </h2>
              <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                {formatTimecode(currentTime)} / {formatTimecode(project.duration_sec)}
                {activeClip && (
                  <>
                    {' · '}Clip {formatTimecode(activeClip.start_sec)}–{formatTimecode(activeClip.end_sec)}
                    {' · '}
                    {(activeClip.end_sec - activeClip.start_sec).toFixed(2)}s
                    {activeClip.category ? ` · ${activeClip.category}` : ''}
                  </>
                )}
              </p>
            </div>

            {/* Interactive Aspect Ratio Segmented Control */}
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-md shrink-0">
              <button
                type="button"
                onClick={() => onAspectRatioChange('16:9')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  aspectRatio === '16:9'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                16:9 Landscape
              </button>
              <button
                type="button"
                onClick={() => onAspectRatioChange('9:16')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  aspectRatio === '9:16'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                9:16 Vertical
              </button>
            </div>
          </div>

          {/* Player Canvas */}
          <div className="my-4 flex items-center justify-center bg-[#080B11] border border-slate-800/70 rounded-md p-3 min-h-[340px]">
            <div
              className={`relative overflow-hidden bg-black rounded transition-all duration-150 ${
                aspectRatio === '9:16'
                  ? 'w-[210px] sm:w-[230px] aspect-[9/16]'
                  : 'w-full max-w-[580px] aspect-video'
              }`}
            >
              <video
                ref={videoRef}
                src={apiUrl(project.video_url)}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                playsInline
                className="w-full h-full object-cover"
              />

              {/* Measured Scrim & Live Caption Preview */}
              {(burnCaptions || includeSrt) && (
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 bg-gradient-to-t from-black/75 via-transparent to-black/35">
                  <div className="flex justify-center pt-2">
                    {showHookOverlay && activeClip?.caption_hook && (
                      <div className="bg-slate-50 text-slate-950 font-display font-bold text-center text-[11px] sm:text-xs px-2.5 py-1 rounded shadow-md tracking-tight max-w-[92%]">
                        {activeClip.caption_hook}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-center pb-3">
                    {activeCaptionLine && (
                      <p className="text-center text-white font-semibold text-xs sm:text-sm leading-snug drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)] bg-black/55 px-2.5 py-1 rounded max-w-[94%]">
                        {activeCaptionLine}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Transport Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isPlaying ? 'Pause' : 'Play Clip'}
              </button>
              <button
                type="button"
                onClick={() => activeClip && seekTo(activeClip.start_sec)}
                disabled={!activeClip}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-300 rounded border border-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Jump Start
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                className="p-1.5 text-slate-300 hover:text-white bg-[#0B0F17] border border-slate-800 rounded transition-colors"
              >
                {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={loopClip}
                onChange={(e) => setLoopClip(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500"
              />
              Loop active clip range
            </label>
          </div>
        </div>

        {/* Right: Export & Render Options */}
        <div className="xl:col-span-5 bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="pb-3 border-b border-slate-800/80">
              <h3 className="text-sm font-semibold text-slate-100">Clip Export & Render Options</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Processed locally via FFmpegVideoProcessor with zero cloud upload.
              </p>
            </div>

            {/* Encode Mode */}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-slate-300">Encoding Pipeline</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onEncodeModeChange('reencode')}
                  className={`px-3 py-2 text-left rounded border transition-colors ${
                    encodeMode === 'reencode'
                      ? 'bg-blue-600/15 border-blue-500/70 text-slate-100'
                      : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-semibold">Re-encode (H.264)</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Supports 9:16 crop & ASS burn-in
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onEncodeModeChange('stream_copy');
                    onAspectRatioChange('16:9');
                    onBurnCaptionsChange(false);
                  }}
                  className={`px-3 py-2 text-left rounded border transition-colors ${
                    encodeMode === 'stream_copy'
                      ? 'bg-blue-600/15 border-blue-500/70 text-slate-100'
                      : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-semibold">Stream Copy (-c copy)</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Instant lossless 16:9 keyframe cut
                  </div>
                </button>
              </div>
            </div>

            {/* Caption Flags */}
            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSrt}
                  onChange={(e) => onIncludeSrtChange(e.target.checked)}
                  className="mt-0.5 rounded border-slate-700 bg-slate-900 text-blue-600"
                />
                <span>
                  <span className="font-medium text-slate-200 block">Export sidecar .srt subtitles</span>
                  <span className="text-slate-400">Time-shifted relative to clip start (00:00:00,000)</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={burnCaptions}
                  disabled={encodeMode === 'stream_copy'}
                  onChange={(e) => onBurnCaptionsChange(e.target.checked)}
                  className="mt-0.5 rounded border-slate-700 bg-slate-900 text-blue-600 disabled:opacity-40"
                />
                <span>
                  <span className="font-medium text-slate-200 block">
                    Burn-in styled .ass captions + hook banner
                  </span>
                  <span className="text-slate-400">
                    {encodeMode === 'stream_copy'
                      ? 'Switch to Re-encode to burn filters into video frames'
                      : 'Renders crisp libass subtitles & opening hook card'}
                  </span>
                </span>
              </label>
            </div>

            {/* Fine Trim Nudgers */}
            {activeClip && (
              <div className="pt-2 border-t border-slate-800/80 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Fine Trim Boundaries</span>
                  <span className="font-mono tabular-nums text-slate-300">
                    {(activeClip.end_sec - activeClip.start_sec).toFixed(2)}s
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center justify-between bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400">In</span>
                    <div className="flex items-center gap-1 font-mono tabular-nums">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateClipBounds(
                            activeClip.id,
                            Math.max(0, activeClip.start_sec - 0.25),
                            activeClip.end_sec
                          )
                        }
                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
                      >
                        -0.25
                      </button>
                      <span className="px-1 text-slate-100">{activeClip.start_sec.toFixed(2)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateClipBounds(
                            activeClip.id,
                            Math.min(activeClip.end_sec - 1, activeClip.start_sec + 0.25),
                            activeClip.end_sec
                          )
                        }
                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
                      >
                        +0.25
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400">Out</span>
                    <div className="flex items-center gap-1 font-mono tabular-nums">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateClipBounds(
                            activeClip.id,
                            activeClip.start_sec,
                            Math.max(activeClip.start_sec + 1, activeClip.end_sec - 0.25)
                          )
                        }
                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
                      >
                        -0.25
                      </button>
                      <span className="px-1 text-slate-100">{activeClip.end_sec.toFixed(2)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateClipBounds(
                            activeClip.id,
                            activeClip.start_sec,
                            Math.min(project.duration_sec, activeClip.end_sec + 0.25)
                          )
                        }
                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
                      >
                        +0.25
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Primary Actions + Last Export Download */}
          <div className="space-y-3 pt-2 border-t border-slate-800/80">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!activeClip || isExporting}
                onClick={onExportClip}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap"
              >
                <Scissors className="w-3.5 h-3.5" />
                {isExporting ? 'Rendering with FFmpeg...' : 'Render & Export Clip'}
              </button>
              <button
                type="button"
                disabled={!activeClip}
                onClick={() => activeClip && onOpenQueueModal(activeClip)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                Queue Post
              </button>
            </div>

            {lastExport && (
              <div className="bg-[#0B0F17] border border-emerald-500/35 rounded p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-emerald-400">
                    Rendered {lastExport.clip_id}
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {lastExport.aspect_ratio} · {(lastExport.file_size_bytes / 1024).toFixed(0)} KB
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <a
                    href={apiUrl(lastExport.video_url)}
                    download
                    className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 underline underline-offset-2"
                  >
                    <Film className="w-3.5 h-3.5" />
                    Download MP4
                  </a>
                  {lastExport.srt_url && (
                    <a
                      href={apiUrl(lastExport.srt_url)}
                      download
                      className="inline-flex items-center gap-1 text-slate-300 hover:text-white underline underline-offset-2"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download SRT
                    </a>
                  )}
                  {lastExport.ass_url && (
                    <a
                      href={apiUrl(lastExport.ass_url)}
                      download
                      className="inline-flex items-center gap-1 text-slate-300 hover:text-white underline underline-offset-2"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download ASS
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Multi-Clip Timeline Strip */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-3">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span>Source Timeline ({clips.length} grounded clips)</span>
          <span className="font-mono tabular-nums">
            00:00.00 — {formatTimecode(project.duration_sec)}
          </span>
        </div>
        <div
          className="relative h-10 bg-[#0B0F17] border border-slate-800 rounded overflow-hidden cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            seekTo(pct * project.duration_sec);
          }}
        >
          {clips.map((clip) => {
            const leftPct = (clip.start_sec / Math.max(1, project.duration_sec)) * 100;
            const widthPct = Math.max(
              2,
              ((clip.end_sec - clip.start_sec) / Math.max(1, project.duration_sec)) * 100
            );
            const isActive = activeClip?.id === clip.id;
            return (
              <button
                key={clip.id}
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelectClip(clip);
                  seekTo(clip.start_sec);
                }}
                title={`${clip.title} (${clip.start_sec.toFixed(1)}s - ${clip.end_sec.toFixed(1)}s)`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                className={`absolute top-1.5 bottom-1.5 rounded-sm border text-[11px] font-medium px-1.5 truncate text-left transition-colors ${
                  isActive
                    ? 'bg-blue-600/35 border-blue-400 text-white'
                    : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700/80'
                }`}
              >
                {clip.id}
              </button>
            );
          })}

          {/* Playhead */}
          <div
            style={{
              left: `${(currentTime / Math.max(1, project.duration_sec)) * 100}%`,
            }}
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-amber-400"
          />
        </div>
      </div>
    </div>
  );
};
