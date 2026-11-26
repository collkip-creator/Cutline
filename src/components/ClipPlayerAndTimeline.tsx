import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  Check,
  Copy,
  Download,
  Eye,
  Film,
  HardDrive,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Send,
  SlidersHorizontal,
  Trash2,
  Volume2,
  VolumeX,
  X,
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
import {
  buildExportFilename,
  cacheExportInLocalStorage,
  deleteLocalExport,
  downloadUrlViaBlob,
  listLocalExports,
  makeLocalExportKey,
  triggerBlobDownload,
  type LocalExportEntry,
} from '../lib/localExports';
import {
  ClipSubtitleEditor,
  DEFAULT_SUBTITLE_CONFIG,
} from './ClipSubtitleEditor';

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
  onChangeClip: (updated: ClipCandidate) => void;
  onUpdateClipBounds: (clipId: string, startSec: number, endSec: number) => void;
  onAddClipRange: (startSec: number, endSec: number) => void;
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
  onChangeClip,
  onUpdateClipBounds,
  onAddClipRange,
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
  const [markInSec, setMarkInSec] = useState<number | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<'export' | 'subtitles'>('export');
  const [savedExports, setSavedExports] = useState<LocalExportEntry[]>([]);
  const [isCachingExport, setIsCachingExport] = useState(false);
  const [downloadingAction, setDownloadingAction] = useState<string | null>(null);
  const [exportActionError, setExportActionError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<{
    title: string;
    clipId: string;
    aspectRatio: AspectRatio;
    fileSizeBytes: number;
    videoPath: string;
    sourceLabel: string;
    objectUrl: string;
    isObjectUrl: boolean;
    srtUrl: string | null;
    assUrl: string | null;
    entry?: LocalExportEntry;
    exportResult?: ExportResult;
  } | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);

  const closePreview = () => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    setPreviewTarget(null);
  };

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  // Reset active mark and refresh local storage export history when switching projects
  useEffect(() => {
    setMarkInSec(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setExportActionError(null);
    closePreview();
    listLocalExports(project.video_hash)
      .then((items) => setSavedExports(items))
      .catch(() => setSavedExports([]));
  }, [project.video_hash]);

  // Cache every newly rendered clip into browser local storage (IndexedDB) for offline preview & direct download
  useEffect(() => {
    if (!lastExport) return;
    let cancelled = false;
    setIsCachingExport(true);
    setExportActionError(null);
    const clipTitle =
      clips.find((c) => c.id === lastExport.clip_id)?.title || lastExport.clip_id;
    cacheExportInLocalStorage(project.video_hash, clipTitle, lastExport)
      .then(async () => {
        if (cancelled) return;
        const items = await listLocalExports(project.video_hash);
        if (!cancelled) setSavedExports(items);
      })
      .catch(() => {
        // Non-fatal: preview and blob download still work directly from sidecar URL
      })
      .finally(() => {
        if (!cancelled) setIsCachingExport(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lastExport, project.video_hash]);

  // Seek player to active clip start when selection changes
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !activeClip || markInSec !== null) return;
    vid.currentTime = activeClip.start_sec;
    setCurrentTime(activeClip.start_sec);
  }, [activeClip?.id]);

  // Sync playhead and clip looping (paused while actively marking a new clip)
  const handleTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const t = vid.currentTime;
    setCurrentTime(t);
    if (loopClip && activeClip && markInSec === null && t >= activeClip.end_sec) {
      vid.currentTime = activeClip.start_sec;
      if (isPlaying) {
        vid.play().catch(() => {});
      }
    }
  };

  const handleStartMark = () => {
    const t = videoRef.current ? videoRef.current.currentTime : currentTime;
    setMarkInSec(Math.round(t * 100) / 100);
  };

  const handleEndMark = () => {
    if (markInSec === null) return;
    const t = videoRef.current ? videoRef.current.currentTime : currentTime;
    const s = Math.min(markInSec, t);
    const e = Math.max(markInSec, t);
    const safeEnd = Math.min(project.duration_sec, Math.max(s + Math.min(1.0, project.duration_sec - s), e));
    onAddClipRange(Math.round(s * 100) / 100, Math.round(safeEnd * 100) / 100);
    setMarkInSec(null);
  };

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && previewTarget !== null) {
        ev.preventDefault();
        closePreview();
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (ev.key === 'i' || ev.key === 'I') {
        ev.preventDefault();
        handleStartMark();
      } else if ((ev.key === 'o' || ev.key === 'O') && markInSec !== null) {
        ev.preventDefault();
        handleEndMark();
      } else if (ev.key === 'Escape' && markInSec !== null) {
        ev.preventDefault();
        setMarkInSec(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [markInSec, previewTarget, currentTime, project.duration_sec]);

  const pauseMainPlayer = () => {
    const vid = videoRef.current;
    if (vid && !vid.paused) {
      vid.pause();
      setIsPlaying(false);
    }
  };

  const openEntryPreview = (entry: LocalExportEntry) => {
    pauseMainPlayer();
    closePreview();
    const url = URL.createObjectURL(entry.video_blob);
    previewObjectUrlRef.current = url;
    setPreviewTarget({
      title: entry.clip_title || entry.clip_id,
      clipId: entry.clip_id,
      aspectRatio: entry.aspect_ratio,
      fileSizeBytes: entry.file_size_bytes,
      videoPath: entry.video_path,
      sourceLabel: 'Browser Local Storage',
      objectUrl: url,
      isObjectUrl: true,
      srtUrl: entry.srt_url,
      assUrl: entry.ass_url,
      entry,
    });
  };

  const openLastExportPreview = async (exp: ExportResult) => {
    const cached = savedExports.find(
      (item) => item.key === makeLocalExportKey(project.video_hash, exp)
    );
    if (cached) {
      openEntryPreview(cached);
      return;
    }
    pauseMainPlayer();
    closePreview();
    const clipTitle = clips.find((c) => c.id === exp.clip_id)?.title || exp.clip_id;
    try {
      setDownloadingAction('preview');
      const entry = await cacheExportInLocalStorage(project.video_hash, clipTitle, exp);
      const items = await listLocalExports(project.video_hash);
      setSavedExports(items);
      openEntryPreview(entry);
    } catch {
      // Fallback to direct sidecar stream inside the modal if IndexedDB cache fails
      setPreviewTarget({
        title: clipTitle,
        clipId: exp.clip_id,
        aspectRatio: exp.aspect_ratio,
        fileSizeBytes: exp.file_size_bytes,
        videoPath: exp.video_path,
        sourceLabel: 'Local Sidecar Stream',
        objectUrl: apiUrl(exp.video_url),
        isObjectUrl: false,
        srtUrl: exp.srt_url,
        assUrl: exp.ass_url,
        exportResult: exp,
      });
    } finally {
      setDownloadingAction(null);
    }
  };

  const handleDownloadAsset = async (
    format: 'mp4' | 'srt' | 'ass',
    options: { entry?: LocalExportEntry; exportResult?: ExportResult; actionId: string }
  ) => {
    const { entry, exportResult, actionId } = options;
    setExportActionError(null);
    setDownloadingAction(actionId);
    try {
      const clipId = entry?.clip_id || exportResult?.clip_id || 'clip';
      const ratio = entry?.aspect_ratio || exportResult?.aspect_ratio || aspectRatio;
      const filename = buildExportFilename(clipId, ratio, format);

      if (format === 'mp4') {
        if (entry?.video_blob) {
          triggerBlobDownload(entry.video_blob, filename);
          return;
        }
        if (exportResult) {
          await downloadUrlViaBlob(apiUrl(exportResult.video_url), filename);
        }
        return;
      }

      if (format === 'srt') {
        if (entry?.srt_blob) {
          triggerBlobDownload(entry.srt_blob, filename);
          return;
        }
        const url = entry?.srt_url || exportResult?.srt_url;
        if (url) await downloadUrlViaBlob(apiUrl(url), filename);
        return;
      }

      if (format === 'ass') {
        if (entry?.ass_blob) {
          triggerBlobDownload(entry.ass_blob, filename);
          return;
        }
        const url = entry?.ass_url || exportResult?.ass_url;
        if (url) await downloadUrlViaBlob(apiUrl(url), filename);
      }
    } catch (err: any) {
      setExportActionError(err?.message || `Failed to save ${format.toUpperCase()} file.`);
    } finally {
      setDownloadingAction(null);
    }
  };

  const handleDeleteSavedExport = async (key: string) => {
    try {
      await deleteLocalExport(key);
      const items = await listLocalExports(project.video_hash);
      setSavedExports(items);
      if (previewTarget?.entry?.key === key) {
        closePreview();
      }
    } catch {
      // ignore
    }
  };

  const handleCopyPath = async (pathText: string) => {
    try {
      await navigator.clipboard?.writeText(pathText);
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1800);
    } catch {
      // ignore
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

  const activeSubtitleConfig = useMemo(
    () => ({
      ...DEFAULT_SUBTITLE_CONFIG,
      ...(activeClip?.subtitles || {}),
    }),
    [activeClip?.subtitles]
  );

  const subtitlesPreviewVisible = activeClip?.subtitles
    ? activeClip.subtitles.enabled
    : burnCaptions || includeSrt;

  const clipRelativeTime = activeClip
    ? Math.max(0, currentTime - activeClip.start_sec)
    : 0;

  // Determine live caption text at current playhead
  const activeCaptionLine = useMemo(() => {
    if (!subtitlesPreviewVisible) return '';

    const customCues = activeClip?.subtitles?.custom_cues;
    if (Array.isArray(customCues)) {
      if (!activeClip) return '';
      const rel = currentTime - activeClip.start_sec;
      const hit = customCues.find((c) => rel >= c.start_sec - 0.05 && rel <= c.end_sec + 0.05);
      return hit?.text.trim() || '';
    }

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
  }, [subtitlesPreviewVisible, activeClip, transcript, currentTime]);

  const showHookOverlay =
    subtitlesPreviewVisible &&
    activeSubtitleConfig.show_hook_banner &&
    Boolean(activeClip?.caption_hook) &&
    Boolean(activeClip) &&
    currentTime >= (activeClip?.start_sec ?? 0) &&
    currentTime <= (activeClip?.start_sec ?? 0) + 3.5;

  const subtitleFontClass =
    activeSubtitleConfig.font_size >= 54
      ? 'text-sm sm:text-base'
      : activeSubtitleConfig.font_size >= 46
        ? 'text-xs sm:text-sm'
        : activeSubtitleConfig.font_size >= 38
          ? 'text-[11px] sm:text-xs'
          : 'text-[10px] sm:text-[11px]';

  const subtitlePresetClass =
    activeSubtitleConfig.preset === 'bold_box'
      ? 'text-white font-bold bg-[#0B0F17]/95 border border-slate-700/80 px-3 py-1.5 rounded shadow-lg'
      : activeSubtitleConfig.preset === 'yellow_pop'
        ? 'text-amber-300 font-extrabold uppercase tracking-tight bg-black/50 px-2.5 py-1 rounded drop-shadow-[0_2px_4px_rgba(0,0,0,0.98)]'
        : activeSubtitleConfig.preset === 'minimal'
          ? 'text-slate-100 font-medium px-2 py-0.5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)]'
          : 'text-white font-semibold bg-black/55 px-2.5 py-1 rounded drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]';

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
              {subtitlesPreviewVisible && (
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 bg-gradient-to-t from-black/75 via-transparent to-black/35">
                  <div className="flex flex-col items-center gap-2 pt-2">
                    {showHookOverlay && activeClip?.caption_hook && (
                      <div className="bg-slate-50 text-slate-950 font-display font-bold text-center text-[11px] sm:text-xs px-2.5 py-1 rounded shadow-md tracking-tight max-w-[92%]">
                        {activeClip.caption_hook}
                      </div>
                    )}
                    {activeSubtitleConfig.position === 'top' && activeCaptionLine && (
                      <p className={`text-center leading-snug max-w-[94%] ${subtitleFontClass} ${subtitlePresetClass}`}>
                        {activeCaptionLine}
                      </p>
                    )}
                  </div>

                  <div className="flex justify-center">
                    {activeSubtitleConfig.position === 'middle' && activeCaptionLine && (
                      <p className={`text-center leading-snug max-w-[94%] ${subtitleFontClass} ${subtitlePresetClass}`}>
                        {activeCaptionLine}
                      </p>
                    )}
                  </div>

                  <div className="flex justify-center pb-3">
                    {activeSubtitleConfig.position === 'bottom' && activeCaptionLine && (
                      <p className={`text-center leading-snug max-w-[94%] ${subtitleFontClass} ${subtitlePresetClass}`}>
                        {activeCaptionLine}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Transport & Live Clip Marking Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-slate-800/80">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isPlaying ? 'Pause' : 'Play'}
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

              <span className="h-4 w-px bg-slate-800 mx-0.5 hidden sm:inline-block" aria-hidden="true" />

              {markInSec === null ? (
                <button
                  type="button"
                  onClick={handleStartMark}
                  title="Mark clip start at current playhead (Shortcut: I)"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 border border-emerald-500/45 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  Start New Clip (I)
                </button>
              ) : (
                <div className="inline-flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleEndMark}
                    title="Finish and save clip at current playhead (Shortcut: O)"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    End &amp; Save Clip (O)
                  </button>
                  <span className="text-[11px] font-mono tabular-nums text-emerald-300 px-1.5">
                    {formatTimecode(markInSec)} → {formatTimecode(currentTime)} (
                    {Math.abs(currentTime - markInSec).toFixed(2)}s)
                  </span>
                  <button
                    type="button"
                    onClick={() => setMarkInSec(null)}
                    className="px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200 border border-slate-800 rounded"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={loopClip}
                onChange={(e) => setLoopClip(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500"
              />
              Loop active clip
            </label>
          </div>
        </div>

        {/* Right: Export, Trim & Clip Subtitles */}
        <div className="xl:col-span-5 bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {rightPanelTab === 'subtitles' ? 'Clip Subtitles & Styling' : 'Clip Export & Render Options'}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {rightPanelTab === 'subtitles'
                    ? 'Customize on-clip subtitle lines, preset style, placement & size.'
                    : 'Processed locally via FFmpegVideoProcessor with zero cloud upload.'}
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-md shrink-0">
                <button
                  type="button"
                  onClick={() => setRightPanelTab('export')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    rightPanelTab === 'export'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <SlidersHorizontal className="w-3 h-3" />
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => setRightPanelTab('subtitles')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    rightPanelTab === 'subtitles'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Captions className="w-3 h-3" />
                  Subtitles
                  {activeClip?.subtitles?.custom_cues?.length ? (
                    <span className="px-1 py-0.2 text-[10px] rounded bg-black/30 text-blue-200 font-mono">
                      {activeClip.subtitles.custom_cues.length}
                    </span>
                  ) : null}
                </button>
              </div>
            </div>

            {rightPanelTab === 'subtitles' ? (
              activeClip ? (
                <ClipSubtitleEditor
                  clip={activeClip}
                  transcript={transcript}
                  aspectRatio={aspectRatio}
                  clipRelativeTime={clipRelativeTime}
                  onSeekRelative={(relSec) => seekTo(activeClip.start_sec + relSec)}
                  onChangeClip={onChangeClip}
                  onEnableSubtitlesSideEffects={() => {
                    if (encodeMode === 'stream_copy') {
                      onEncodeModeChange('reencode');
                    }
                    if (!burnCaptions) {
                      onBurnCaptionsChange(true);
                    }
                  }}
                />
              ) : (
                <div className="bg-[#0B0F17] border border-slate-800 rounded p-4 text-center text-xs text-slate-400">
                  Select or mark a clip on the timeline to edit subtitles.
                </div>
              )
            ) : (
              <>
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

              {activeClip && (
                <button
                  type="button"
                  onClick={() => setRightPanelTab('subtitles')}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-400 hover:text-blue-300 pt-0.5"
                >
                  <Captions className="w-3.5 h-3.5" />
                  Edit clip subtitle lines &amp; styling ({activeSubtitleConfig.preset.replace('_', ' ')}) →
                </button>
              )}
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
                  <div className="flex items-center justify-between bg-[#0B0F17] border border-slate-800 rounded px-2 py-1.5">
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
                            Math.min(activeClip.end_sec - 0.5, activeClip.start_sec + 0.25),
                            activeClip.end_sec
                          )
                        }
                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
                      >
                        +0.25
                      </button>
                      <button
                        type="button"
                        title="Set clip start to current playhead"
                        onClick={() => {
                          const nextIn = Math.min(activeClip.end_sec - 0.5, currentTime);
                          onUpdateClipBounds(activeClip.id, Math.max(0, nextIn), activeClip.end_sec);
                        }}
                        className="px-1.5 py-0.5 bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 rounded text-blue-300 font-sans text-[10px]"
                      >
                        Set
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between bg-[#0B0F17] border border-slate-800 rounded px-2 py-1.5">
                    <span className="text-slate-400">Out</span>
                    <div className="flex items-center gap-1 font-mono tabular-nums">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateClipBounds(
                            activeClip.id,
                            activeClip.start_sec,
                            Math.max(activeClip.start_sec + 0.5, activeClip.end_sec - 0.25)
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
                      <button
                        type="button"
                        title="Set clip end to current playhead"
                        onClick={() => {
                          const nextOut = Math.max(activeClip.start_sec + 0.5, currentTime);
                          onUpdateClipBounds(
                            activeClip.id,
                            activeClip.start_sec,
                            Math.min(project.duration_sec, nextOut)
                          );
                        }}
                        className="px-1.5 py-0.5 bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 rounded text-blue-300 font-sans text-[10px]"
                      >
                        Set
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
              </>
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
                Share / Queue
              </button>
            </div>

            {lastExport && (() => {
              const cachedLast = savedExports.find(
                (item) => item.key === makeLocalExportKey(project.video_hash, lastExport)
              );
              return (
                <div className="bg-[#0B0F17] border border-emerald-500/35 rounded p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-emerald-400">
                        Rendered {lastExport.clip_id}
                      </span>
                      <span className="text-[11px] text-slate-400 truncate">
                        {isCachingExport
                          ? 'Saving to local storage...'
                          : cachedLast
                            ? 'Cached in local storage'
                            : 'Saved on disk'}
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-slate-400 shrink-0">
                      {lastExport.aspect_ratio} · {(lastExport.file_size_bytes / 1024).toFixed(0)} KB
                    </span>
                  </div>

                  {lastExport.video_path && (
                    <div className="flex items-center justify-between gap-2 bg-[#111724] border border-slate-800 rounded px-2 py-1">
                      <span
                        className="text-[10px] font-mono text-slate-400 truncate"
                        title={lastExport.video_path}
                      >
                        {lastExport.video_path}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyPath(lastExport.video_path)}
                        className="inline-flex items-center gap-1 text-[10px] text-slate-300 hover:text-white shrink-0"
                      >
                        {copiedPath ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Copy Path
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <button
                      type="button"
                      disabled={downloadingAction === 'preview'}
                      onClick={() => openLastExportPreview(lastExport)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-100 font-medium transition-colors"
                    >
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      {downloadingAction === 'preview' ? 'Opening...' : 'Preview in App'}
                    </button>
                    <button
                      type="button"
                      disabled={downloadingAction === 'last-mp4'}
                      onClick={() =>
                        handleDownloadAsset('mp4', {
                          entry: cachedLast,
                          exportResult: lastExport,
                          actionId: 'last-mp4',
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 rounded text-blue-300 font-medium transition-colors"
                    >
                      <Film className="w-3.5 h-3.5" />
                      {downloadingAction === 'last-mp4' ? 'Saving...' : 'Download MP4'}
                    </button>
                    {lastExport.srt_url && (
                      <button
                        type="button"
                        disabled={downloadingAction === 'last-srt'}
                        onClick={() =>
                          handleDownloadAsset('srt', {
                            entry: cachedLast,
                            exportResult: lastExport,
                            actionId: 'last-srt',
                          })
                        }
                        className="inline-flex items-center gap-1 px-2 py-1.5 bg-slate-800/70 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 hover:text-white transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {downloadingAction === 'last-srt' ? 'Saving...' : 'SRT'}
                      </button>
                    )}
                    {lastExport.ass_url && (
                      <button
                        type="button"
                        disabled={downloadingAction === 'last-ass'}
                        onClick={() =>
                          handleDownloadAsset('ass', {
                            entry: cachedLast,
                            exportResult: lastExport,
                            actionId: 'last-ass',
                          })
                        }
                        className="inline-flex items-center gap-1 px-2 py-1.5 bg-slate-800/70 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 hover:text-white transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {downloadingAction === 'last-ass' ? 'Saving...' : 'ASS'}
                      </button>
                    )}
                  </div>

                  {exportActionError && (
                    <p className="text-[11px] text-rose-400">{exportActionError}</p>
                  )}
                </div>
              );
            })()}

            {savedExports.length > 0 && (
              <div className="bg-[#0B0F17] border border-slate-800 rounded p-2.5 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1.5 font-medium text-slate-300">
                    <HardDrive className="w-3.5 h-3.5 text-slate-400" />
                    Local Storage Previews ({savedExports.length})
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">IndexedDB cache</span>
                </div>
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-0.5">
                  {savedExports.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 bg-[#111724] border border-slate-800/80 rounded text-[11px]"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-slate-200">{entry.clip_id}</span>
                        <span className="text-slate-500 mx-1.5">·</span>
                        <span className="font-mono tabular-nums text-slate-400">
                          {entry.aspect_ratio} · {(entry.file_size_bytes / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => openEntryPreview(entry)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-200"
                        >
                          <Eye className="w-3 h-3 text-emerald-400" />
                          Preview
                        </button>
                        <button
                          type="button"
                          disabled={downloadingAction === `saved-${entry.key}`}
                          onClick={() =>
                            handleDownloadAsset('mp4', {
                              entry,
                              actionId: `saved-${entry.key}`,
                            })
                          }
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 rounded text-blue-300"
                        >
                          <Download className="w-3 h-3" />
                          {downloadingAction === `saved-${entry.key}` ? '...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSavedExport(entry.key)}
                          title="Remove from local browser cache"
                          className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
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

          {/* Live Marked Range Band */}
          {markInSec !== null && (() => {
            const total = Math.max(1, project.duration_sec);
            const lo = Math.min(markInSec, currentTime);
            const hi = Math.max(markInSec, currentTime);
            const leftPct = (lo / total) * 100;
            const widthPct = Math.max(0.8, ((hi - lo) / total) * 100);
            return (
              <div
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                className="pointer-events-none absolute top-0.5 bottom-0.5 bg-emerald-500/25 border border-emerald-400/80 rounded-sm"
              />
            );
          })()}

          {/* Playhead */}
          <div
            style={{
              left: `${(currentTime / Math.max(1, project.duration_sec)) * 100}%`,
            }}
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-amber-400"
          />
        </div>
      </div>

      {/* In-App Local Export Preview Modal */}
      {previewTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewTarget.clipId}`}
        >
          <div className="w-full max-w-3xl bg-[#111724] border border-slate-700 rounded-lg overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3 bg-[#0B0F17]">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={closePreview}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded transition-colors shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to Editor
                </button>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-100 truncate">
                    {previewTarget.clipId} · {previewTarget.title}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                    {previewTarget.aspectRatio} · {(previewTarget.fileSizeBytes / 1024).toFixed(0)} KB ·{' '}
                    {previewTarget.sourceLabel}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={closePreview}
                aria-label="Close preview"
                className="p-1.5 text-slate-400 hover:text-white bg-slate-800/70 hover:bg-slate-700 rounded transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-[#070A10] flex items-center justify-center overflow-auto flex-1">
              <div
                className={
                  previewTarget.aspectRatio === '9:16'
                    ? 'aspect-[9/16] h-[60vh] max-h-[540px] bg-black border border-slate-800 rounded overflow-hidden'
                    : 'aspect-video w-full max-w-2xl bg-black border border-slate-800 rounded overflow-hidden'
                }
              >
                <video
                  key={previewTarget.objectUrl}
                  src={previewTarget.objectUrl}
                  controls
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain bg-black"
                />
              </div>
            </div>

            <div className="px-4 py-3 border-t border-slate-800 bg-[#0B0F17] flex flex-wrap items-center justify-between gap-3">
              <span
                className="text-[11px] font-mono text-slate-400 truncate max-w-md"
                title={previewTarget.videoPath}
              >
                {previewTarget.videoPath}
              </span>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  disabled={downloadingAction === 'modal-mp4'}
                  onClick={() =>
                    handleDownloadAsset('mp4', {
                      entry: previewTarget.entry,
                      exportResult: previewTarget.exportResult,
                      actionId: 'modal-mp4',
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  {downloadingAction === 'modal-mp4' ? 'Saving MP4...' : 'Download MP4'}
                </button>
                {previewTarget.srtUrl && (
                  <button
                    type="button"
                    disabled={downloadingAction === 'modal-srt'}
                    onClick={() =>
                      handleDownloadAsset('srt', {
                        entry: previewTarget.entry,
                        exportResult: previewTarget.exportResult,
                        actionId: 'modal-srt',
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    SRT
                  </button>
                )}
                {previewTarget.assUrl && (
                  <button
                    type="button"
                    disabled={downloadingAction === 'modal-ass'}
                    onClick={() =>
                      handleDownloadAsset('ass', {
                        entry: previewTarget.entry,
                        exportResult: previewTarget.exportResult,
                        actionId: 'modal-ass',
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    ASS
                  </button>
                )}
                {(() => {
                  const targetClip =
                    clips.find((c) => c.id === previewTarget.clipId) || activeClip;
                  if (!targetClip) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        closePreview();
                        onOpenQueueModal(targetClip);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-300 font-semibold rounded transition-colors"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Share / Queue
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
