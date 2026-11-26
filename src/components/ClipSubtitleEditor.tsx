import React from 'react';
import {
  AlignCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Captions,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AspectRatio,
  ClipCandidate,
  SubtitleConfig,
  SubtitleCue,
  SubtitlePosition,
  SubtitlePreset,
  Transcript,
  WordTimestamp,
} from '../types';

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  enabled: true,
  preset: 'classic',
  position: 'bottom',
  font_size: 44,
  show_hook_banner: true,
};

export function buildDefaultCuesFromTranscript(
  clip: ClipCandidate,
  transcript: Transcript | null,
  maxWordsPerLine = 5
): SubtitleCue[] {
  if (!transcript) return [];
  const allWords: WordTimestamp[] = transcript.segments.flatMap((seg) => {
    if (seg.words && seg.words.length > 0) return seg.words;
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const step = Math.max(0.05, (seg.end_sec - seg.start_sec) / tokens.length);
    return tokens.map((word, idx) => {
      const s = Math.round((seg.start_sec + idx * step) * 1000) / 1000;
      const e = Math.round(Math.min(seg.end_sec, s + step) * 1000) / 1000;
      return { word, start_sec: s, end_sec: e, confidence: 0.95 };
    });
  });

  const clipped = allWords.filter(
    (w) => w.end_sec > clip.start_sec && w.start_sec < clip.end_sec
  );
  if (clipped.length === 0) return [];

  const clipDur = Math.max(0.5, clip.end_sec - clip.start_sec);
  const cues: SubtitleCue[] = [];
  let bucket: WordTimestamp[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const s = Math.max(0, Math.round((bucket[0].start_sec - clip.start_sec) * 100) / 100);
    const e = Math.min(
      clipDur,
      Math.max(s + 0.25, Math.round((bucket[bucket.length - 1].end_sec - clip.start_sec) * 100) / 100)
    );
    cues.push({
      id: `cue_${cues.length + 1}_${Math.round(s * 100)}`,
      start_sec: s,
      end_sec: e,
      text: bucket.map((w) => w.word).join(' '),
    });
    bucket = [];
  };

  for (const w of clipped) {
    if (bucket.length === 0) {
      bucket.push(w);
      continue;
    }
    const span = w.end_sec - bucket[0].start_sec;
    const gap = w.start_sec - bucket[bucket.length - 1].end_sec;
    const endsSentence = /[.!?]$/.test(bucket[bucket.length - 1].word);
    if (bucket.length >= maxWordsPerLine || span >= 2.6 || gap >= 0.45 || endsSentence) {
      flushBucket();
    }
    bucket.push(w);
  }
  flushBucket();

  return cues;
}

function formatRelSec(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

interface ClipSubtitleEditorProps {
  clip: ClipCandidate;
  transcript: Transcript | null;
  aspectRatio: AspectRatio;
  clipRelativeTime: number;
  onSeekRelative: (relSec: number) => void;
  onChangeClip: (updated: ClipCandidate) => void;
  onEnableSubtitlesSideEffects: () => void;
}

const PRESET_OPTIONS: { id: SubtitlePreset; label: string; previewHint: string }[] = [
  { id: 'classic', label: 'Classic', previewHint: 'White · Dark outline' },
  { id: 'bold_box', label: 'Dark Box', previewHint: 'White · Solid pill' },
  { id: 'yellow_pop', label: 'Viral Pop', previewHint: 'Amber · Bold caps' },
  { id: 'minimal', label: 'Minimal', previewHint: 'Clean · Subtle shadow' },
];

const POSITION_OPTIONS: { id: SubtitlePosition; label: string; icon: React.ReactNode }[] = [
  { id: 'bottom', label: 'Bottom', icon: <AlignVerticalJustifyEnd className="w-3 h-3" /> },
  { id: 'middle', label: 'Middle', icon: <AlignCenter className="w-3 h-3" /> },
  { id: 'top', label: 'Top', icon: <AlignVerticalJustifyStart className="w-3 h-3" /> },
];

export const ClipSubtitleEditor: React.FC<ClipSubtitleEditorProps> = ({
  clip,
  transcript,
  aspectRatio,
  clipRelativeTime,
  onSeekRelative,
  onChangeClip,
  onEnableSubtitlesSideEffects,
}) => {
  const clipDuration = Math.max(0.5, Math.round((clip.end_sec - clip.start_sec) * 100) / 100);
  const cfg: SubtitleConfig = {
    ...DEFAULT_SUBTITLE_CONFIG,
    ...(clip.subtitles || {}),
  };
  const customCues = cfg.custom_cues;
  const hasCustomCues = Array.isArray(customCues);

  const updateConfig = (patch: Partial<SubtitleConfig>) => {
    const nextCfg: SubtitleConfig = {
      ...cfg,
      ...patch,
    };
    if (patch.enabled === true) {
      onEnableSubtitlesSideEffects();
    }
    onChangeClip({
      ...clip,
      subtitles: nextCfg,
    });
  };

  const handleGenerateFromTranscript = () => {
    const maxWords = aspectRatio === '9:16' ? 4 : 6;
    const generated = buildDefaultCuesFromTranscript(clip, transcript, maxWords);
    const cuesToUse =
      generated.length > 0
        ? generated
        : [
            {
              id: `cue_1_${Date.now()}`,
              start_sec: 0,
              end_sec: Math.min(clipDuration, 3.0),
              text: clip.caption_hook || clip.title || 'Add subtitle text',
            },
          ];
    onEnableSubtitlesSideEffects();
    updateConfig({ enabled: true, custom_cues: cuesToUse });
  };

  const handleAddCue = () => {
    const baseCues = hasCustomCues
      ? [...(customCues || [])]
      : buildDefaultCuesFromTranscript(clip, transcript, aspectRatio === '9:16' ? 4 : 6);

    const lastEnd = baseCues.length > 0 ? baseCues[baseCues.length - 1].end_sec : 0;
    const clampedPlayhead =
      clipRelativeTime >= 0 && clipRelativeTime < clipDuration - 0.3
        ? Math.round(clipRelativeTime * 100) / 100
        : Math.min(Math.max(0, lastEnd), Math.max(0, clipDuration - 0.5));
    const start = Math.max(0, Math.min(clipDuration - 0.4, clampedPlayhead));
    const end = Math.min(clipDuration, Math.round((start + 2.2) * 100) / 100);

    const nextCues: SubtitleCue[] = [
      ...baseCues,
      {
        id: `cue_${Date.now()}_${baseCues.length + 1}`,
        start_sec: start,
        end_sec: Math.max(start + 0.3, end),
        text: 'New subtitle line',
      },
    ].sort((a, b) => a.start_sec - b.start_sec);

    onEnableSubtitlesSideEffects();
    updateConfig({ enabled: true, custom_cues: nextCues });
  };

  const handleUpdateCue = (cueId: string, patch: Partial<SubtitleCue>) => {
    const source = customCues || [];
    const nextCues = source.map((cue) => {
      if (cue.id !== cueId) return cue;
      const merged = { ...cue, ...patch };
      const s = Math.max(0, Math.min(clipDuration - 0.1, Number(merged.start_sec) || 0));
      const e = Math.max(s + 0.1, Math.min(clipDuration, Number(merged.end_sec) || s + 0.5));
      return {
        ...merged,
        start_sec: Math.round(s * 100) / 100,
        end_sec: Math.round(e * 100) / 100,
      };
    });
    updateConfig({ custom_cues: nextCues });
  };

  const handleDeleteCue = (cueId: string) => {
    const nextCues = (customCues || []).filter((c) => c.id !== cueId);
    updateConfig({ custom_cues: nextCues });
  };

  const handleResetToAuto = () => {
    const nextCfg: SubtitleConfig = {
      enabled: cfg.enabled,
      preset: cfg.preset,
      position: cfg.position,
      font_size: cfg.font_size,
      show_hook_banner: cfg.show_hook_banner,
    };
    onChangeClip({
      ...clip,
      subtitles: nextCfg,
    });
  };

  const autoPreviewCues = !hasCustomCues
    ? buildDefaultCuesFromTranscript(clip, transcript, aspectRatio === '9:16' ? 4 : 6)
    : [];
  const displayedCues = hasCustomCues ? customCues || [] : autoPreviewCues;

  return (
    <div className="space-y-3.5">
      {/* Enable Toggle */}
      <div className="flex items-center justify-between gap-2 bg-[#0B0F17] border border-slate-800 rounded px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Captions className="w-4 h-4 text-blue-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100">Add Subtitles on Clip</div>
            <div className="text-[11px] text-slate-400 truncate">
              Live preview + burned-in MP4 &amp; .srt/.ass export
            </div>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg.enabled}
          onClick={() => updateConfig({ enabled: !cfg.enabled })}
          className={`px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors shrink-0 ${
            cfg.enabled
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
          }`}
        >
          {cfg.enabled ? 'On' : 'Off'}
        </button>
      </div>

      {/* Style Presets */}
      <div className={`space-y-1.5 ${!cfg.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <span className="block text-[11px] font-medium text-slate-400">Subtitle Style</span>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESET_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => updateConfig({ preset: opt.id })}
              className={`px-2.5 py-1.5 text-left rounded border transition-colors ${
                cfg.preset === opt.id
                  ? 'bg-blue-600/15 border-blue-500/70 text-slate-100'
                  : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="text-xs font-semibold">{opt.label}</div>
              <div className="text-[10px] text-slate-400">{opt.previewHint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Position + Font Size + Hook Banner */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-2.5 ${!cfg.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="space-y-1">
          <span className="block text-[11px] font-medium text-slate-400">Placement</span>
          <div className="grid grid-cols-3 gap-1 bg-[#0B0F17] border border-slate-800 rounded p-1">
            {POSITION_OPTIONS.map((pos) => (
              <button
                key={pos.id}
                type="button"
                onClick={() => updateConfig({ position: pos.id })}
                className={`inline-flex items-center justify-center gap-1 py-1 text-[11px] font-medium rounded transition-colors ${
                  cfg.position === pos.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {pos.icon}
                {pos.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-slate-400">Text Size</span>
            <span className="font-mono tabular-nums text-slate-300">{cfg.font_size}px</span>
          </div>
          <div className="flex items-center gap-2 bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5">
            <input
              type="range"
              min={30}
              max={62}
              step={2}
              value={cfg.font_size}
              onChange={(e) => updateConfig({ font_size: Number(e.target.value) })}
              aria-label="Subtitle text size"
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>
        </div>
      </div>

      <label
        className={`flex items-center justify-between gap-2 text-xs text-slate-300 bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5 cursor-pointer ${
          !cfg.enabled ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        <span className="text-[11px] font-medium text-slate-300">
          Show opening hook banner (first 3.5s)
        </span>
        <input
          type="checkbox"
          checked={cfg.show_hook_banner}
          onChange={(e) => updateConfig({ show_hook_banner: e.target.checked })}
          className="rounded border-slate-700 bg-slate-900 text-blue-600"
        />
      </label>

      {/* Subtitle Cues Editor */}
      <div className={`space-y-2 pt-1 border-t border-slate-800/80 ${!cfg.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-slate-300">
            {hasCustomCues
              ? `Custom Subtitle Lines (${displayedCues.length})`
              : `Auto-Synced Lines (${displayedCues.length})`}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {!hasCustomCues && transcript && (
              <button
                type="button"
                onClick={handleGenerateFromTranscript}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-indigo-600/20 hover:bg-indigo-600/35 border border-indigo-500/40 text-indigo-200 rounded transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                Edit Auto Lines
              </button>
            )}
            {hasCustomCues && (
              <button
                type="button"
                onClick={handleResetToAuto}
                title="Clear custom lines and revert to automatic transcript sync"
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#0B0F17] hover:bg-slate-800 border border-slate-800 text-slate-300 rounded transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Auto Sync
              </button>
            )}
            <button
              type="button"
              onClick={handleAddCue}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Line
            </button>
          </div>
        </div>

        {displayedCues.length === 0 ? (
          <div className="bg-[#0B0F17] border border-slate-800/80 rounded p-3 text-center space-y-1.5">
            <p className="text-[11px] text-slate-400">
              {transcript
                ? 'No transcript words overlap this clip range yet.'
                : 'No transcript loaded for this video.'}
            </p>
            <button
              type="button"
              onClick={handleAddCue}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 text-blue-200 rounded"
            >
              <Plus className="w-3 h-3" />
              Create First Subtitle Line
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
            {displayedCues.map((cue) => {
              const isLive =
                clipRelativeTime >= cue.start_sec - 0.05 &&
                clipRelativeTime <= cue.end_sec + 0.05;
              return (
                <div
                  key={cue.id}
                  className={`p-2 rounded border transition-colors space-y-1.5 ${
                    isLive
                      ? 'bg-blue-600/10 border-blue-500/50'
                      : 'bg-[#0B0F17] border-slate-800/90'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSeekRelative(cue.start_sec)}
                      title="Jump video player to this subtitle"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono tabular-nums bg-slate-800/80 hover:bg-slate-700 text-slate-200 rounded"
                    >
                      <Play className="w-2.5 h-2.5 text-blue-400" />
                      {formatRelSec(cue.start_sec)}
                    </button>

                    {hasCustomCues ? (
                      <div className="flex items-center gap-1 text-[10px] font-mono">
                        <input
                          type="number"
                          step="0.1"
                          min={0}
                          max={clipDuration}
                          value={cue.start_sec}
                          aria-label="Subtitle start second"
                          onChange={(e) =>
                            handleUpdateCue(cue.id, { start_sec: Number(e.target.value) })
                          }
                          className="w-14 bg-[#111724] border border-slate-800 rounded px-1.5 py-0.5 text-right text-slate-200 outline-none focus:border-blue-500"
                        />
                        <span className="text-slate-500">→</span>
                        <input
                          type="number"
                          step="0.1"
                          min={0.1}
                          max={clipDuration}
                          value={cue.end_sec}
                          aria-label="Subtitle end second"
                          onChange={(e) =>
                            handleUpdateCue(cue.id, { end_sec: Number(e.target.value) })
                          }
                          className="w-14 bg-[#111724] border border-slate-800 rounded px-1.5 py-0.5 text-right text-slate-200 outline-none focus:border-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteCue(cue.id)}
                          aria-label="Remove subtitle line"
                          className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] font-mono tabular-nums text-slate-400">
                        {formatRelSec(cue.start_sec)} → {formatRelSec(cue.end_sec)}
                      </span>
                    )}
                  </div>

                  {hasCustomCues ? (
                    <input
                      type="text"
                      value={cue.text}
                      onChange={(e) => handleUpdateCue(cue.id, { text: e.target.value })}
                      placeholder="Subtitle text..."
                      className="w-full bg-[#111724] border border-slate-800 focus:border-blue-500 rounded px-2 py-1 text-xs text-slate-100 outline-none"
                    />
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-200 leading-snug">{cue.text}</p>
                      <button
                        type="button"
                        onClick={handleGenerateFromTranscript}
                        className="text-[10px] text-blue-400 hover:text-blue-300 shrink-0"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
