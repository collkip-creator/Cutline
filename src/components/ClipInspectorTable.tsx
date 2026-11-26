import React, { useState } from 'react';
import { Crosshair, FileText, Frown, Minus, Plus, Send, Smile, Trash2 } from 'lucide-react';
import type { AspectRatio, ClipCandidate, ClipSentiment, Transcript } from '../types';
import { apiUrl } from '../lib/api';

interface ClipInspectorTableProps {
  clips: ClipCandidate[];
  activeClipId: string | null;
  transcript: Transcript | null;
  aspectRatio: AspectRatio;
  onSelectClip: (clip: ClipCandidate) => void;
  onChangeClip: (updated: ClipCandidate) => void;
  onDeleteClip: (clipId: string) => void;
  onAddManualClip: () => void;
  onSnapToWords: (clip: ClipCandidate) => Promise<void>;
  onQueueClip: (clip: ClipCandidate) => void;
}

export const ClipInspectorTable: React.FC<ClipInspectorTableProps> = ({
  clips,
  activeClipId,
  transcript,
  aspectRatio,
  onSelectClip,
  onChangeClip,
  onDeleteClip,
  onAddManualClip,
  onSnapToWords,
  onQueueClip,
}) => {
  const [captionPreview, setCaptionPreview] = useState<{
    clipId: string;
    srt: string;
    ass: string;
  } | null>(null);
  const [snappingId, setSnappingId] = useState<string | null>(null);

  const activeClip = clips.find((c) => c.id === activeClipId) || clips[0] || null;

  const handleLoadCaptions = async (clip: ClipCandidate) => {
    if (!transcript && !clip.subtitles?.custom_cues?.length) return;
    const res = await fetch(apiUrl('/api/clips/captions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clip,
        transcript: transcript || null,
        subtitle_config: clip.subtitles || null,
        aspect_ratio: aspectRatio,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setCaptionPreview({ clipId: clip.id, srt: data.srt, ass: data.ass });
    }
  };

  return (
    <div className="bg-[#111724] border border-slate-800/90 rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-800/80">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Editable Clip Candidates</h3>
          <p className="text-xs text-slate-400">
            Click any row to preview; edit fields inline or snap boundaries to spoken word onset/offset.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeClip && (transcript || activeClip.subtitles?.custom_cues?.length) && (
            <button
              type="button"
              onClick={() => handleLoadCaptions(activeClip)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
            >
              <FileText className="w-3.5 h-3.5" />
              Inspect SRT / ASS
            </button>
          )}
          <button
            type="button"
            onClick={onAddManualClip}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Clip
          </button>
        </div>
      </div>

      {clips.length === 0 ? (
        <div className="px-6 py-10 text-center space-y-2">
          <p className="text-sm text-slate-300 font-medium">No clip candidates extracted yet</p>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Run highlight extraction on the cached transcript or add a manual clip range to begin trimming and exporting.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 text-[11px] font-medium text-slate-400 bg-[#0D121D]">
                <th className="py-2.5 px-3">ID & Type</th>
                <th className="py-2.5 px-3 min-w-[200px]">Title & Hook Caption</th>
                <th className="py-2.5 px-3 text-right">Start (s)</th>
                <th className="py-2.5 px-3 text-right">End (s)</th>
                <th className="py-2.5 px-3 text-right min-w-[140px]">Scores (1–10)</th>
                <th className="py-2.5 px-3 min-w-[220px]">Editorial Reason & Tags</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {clips.map((clip) => {
                const isActive = activeClip?.id === clip.id;
                const normScore = (v: number | undefined, fallback = 5.0) => {
                  const n = Number(v ?? fallback);
                  return n > 10 ? Math.round((n / 10) * 10) / 10 : n;
                };
                const hookVal = normScore(clip.hook_score, 5.0);
                const lessonVal = normScore(clip.lesson_score, 5.0);
                const funVal = normScore(clip.entertainment_score, 5.0);

                return (
                  <tr
                    key={clip.id}
                    onClick={() => onSelectClip(clip)}
                    className={`cursor-pointer transition-colors ${
                      isActive ? 'bg-blue-950/30' : 'hover:bg-slate-800/35'
                    }`}
                  >
                    <td className="py-2.5 px-3 font-mono tabular-nums text-slate-300 align-top space-y-1.5" onClick={(e) => e.stopPropagation()}>
                      <div>{clip.id}</div>
                      <select
                        value={clip.category || 'insight'}
                        onChange={(e) =>
                          onChangeClip({
                            ...clip,
                            category: e.target.value as ClipCandidate['category'],
                          })
                        }
                        className="bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-1.5 py-0.5 text-[11px] font-sans text-slate-200 outline-none"
                      >
                        <option value="hook">hook</option>
                        <option value="lesson">lesson</option>
                        <option value="entertainment">entertainment</option>
                        <option value="insight">insight</option>
                      </select>
                      {clip.sentiment && (() => {
                        const sentiment: ClipSentiment = clip.sentiment;
                        const badgeStyles: Record<ClipSentiment, string> = {
                          Positive: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/80',
                          Negative: 'bg-rose-950/60 text-rose-300 border-rose-800/80',
                          Neutral: 'bg-slate-800/70 text-slate-300 border-slate-700/80',
                        };
                        const SentimentIcon =
                          sentiment === 'Positive'
                            ? Smile
                            : sentiment === 'Negative'
                              ? Frown
                              : Minus;
                        return (
                          <div>
                            <span
                              title={`Transcript sentiment: ${sentiment}`}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-sans font-medium ${badgeStyles[sentiment]}`}
                            >
                              <SentimentIcon className="w-3 h-3" />
                              {sentiment}
                            </span>
                          </div>
                        );
                      })()}
                      {clip.snapped_to_words && (
                        <div className="text-[11px] font-sans text-emerald-400">Snapped</div>
                      )}
                    </td>

                    <td className="py-2.5 px-3 align-top space-y-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={clip.title}
                        onChange={(e) => onChangeClip({ ...clip, title: e.target.value })}
                        className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-2 py-1 text-xs font-medium text-slate-100 outline-none"
                      />
                      <input
                        type="text"
                        value={clip.caption_hook}
                        placeholder="Opening caption hook..."
                        onChange={(e) => onChangeClip({ ...clip, caption_hook: e.target.value })}
                        className="w-full bg-[#0B0F17] border border-slate-800/80 focus:border-blue-500 rounded px-2 py-1 text-[11px] text-slate-300 outline-none"
                      />
                    </td>

                    <td className="py-2.5 px-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={clip.start_sec}
                        onChange={(e) =>
                          onChangeClip({
                            ...clip,
                            start_sec: Math.max(0, Number(e.target.value) || 0),
                            snapped_to_words: false,
                          })
                        }
                        className="w-20 text-right font-mono tabular-nums bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-2 py-1 text-xs text-slate-100 outline-none"
                      />
                    </td>

                    <td className="py-2.5 px-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        step="0.1"
                        min="0.5"
                        value={clip.end_sec}
                        onChange={(e) =>
                          onChangeClip({
                            ...clip,
                            end_sec: Math.max(clip.start_sec + 0.5, Number(e.target.value) || 1),
                            snapped_to_words: false,
                          })
                        }
                        className="w-20 text-right font-mono tabular-nums bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-2 py-1 text-xs text-slate-100 outline-none"
                      />
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1">
                        {(clip.end_sec - clip.start_sec).toFixed(2)}s
                      </div>
                    </td>

                    <td className="py-2.5 px-3 align-top space-y-1" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5 text-[11px]">
                        <span className="text-slate-400">Hook</span>
                        <input
                          type="number"
                          step="0.5"
                          min="1"
                          max="10"
                          value={hookVal}
                          onChange={(e) =>
                            onChangeClip({
                              ...clip,
                              hook_score: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                            })
                          }
                          className="w-12 text-right font-mono tabular-nums bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-1.5 py-0.5 text-[11px] font-semibold text-amber-300 outline-none"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-1.5 text-[11px]">
                        <span className="text-slate-400">Lesson</span>
                        <input
                          type="number"
                          step="0.5"
                          min="1"
                          max="10"
                          value={lessonVal}
                          onChange={(e) =>
                            onChangeClip({
                              ...clip,
                              lesson_score: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                            })
                          }
                          className="w-12 text-right font-mono tabular-nums bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 outline-none"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-1.5 text-[11px]">
                        <span className="text-slate-400">Fun</span>
                        <input
                          type="number"
                          step="0.5"
                          min="1"
                          max="10"
                          value={funVal}
                          onChange={(e) =>
                            onChangeClip({
                              ...clip,
                              entertainment_score: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                            })
                          }
                          className="w-12 text-right font-mono tabular-nums bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-1.5 py-0.5 text-[11px] text-blue-300 outline-none"
                        />
                      </div>
                    </td>

                    <td className="py-2.5 px-3 align-top space-y-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={clip.reason}
                        onChange={(e) => onChangeClip({ ...clip, reason: e.target.value })}
                        className="w-full bg-[#0B0F17] border border-slate-800/80 focus:border-blue-500 rounded px-2 py-1 text-xs text-slate-300 outline-none"
                      />
                      <input
                        type="text"
                        value={clip.tags.join(', ')}
                        placeholder="comma, separated, tags"
                        onChange={(e) =>
                          onChangeClip({
                            ...clip,
                            tags: e.target.value
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                          })
                        }
                        className="w-full bg-transparent border-b border-slate-800 focus:border-blue-500 py-0.5 text-[11px] text-slate-400 outline-none"
                      />
                    </td>

                    <td className="py-2.5 px-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={!transcript || snappingId === clip.id}
                          onClick={async () => {
                            setSnappingId(clip.id);
                            await onSnapToWords(clip);
                            setSnappingId(null);
                          }}
                          title="Snap start/end timestamps to exact spoken word boundaries"
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded disabled:opacity-40 whitespace-nowrap"
                        >
                          <Crosshair className="w-3 h-3" />
                          {snappingId === clip.id ? 'Snapping...' : 'Snap'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onQueueClip(clip)}
                          title="Queue clip for social publish"
                          className="p-1.5 text-slate-300 hover:text-white bg-[#0B0F17] hover:bg-slate-800 border border-slate-800 rounded"
                        >
                          <Send className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteClip(clip.id)}
                          title="Remove clip"
                          className="p-1.5 text-slate-400 hover:text-rose-400 bg-[#0B0F17] hover:bg-slate-800 border border-slate-800 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {captionPreview && (
        <div className="border-t border-slate-800 bg-[#0B0F17] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">
              Generated Subtitles for {captionPreview.clipId} ({aspectRatio})
            </span>
            <button
              type="button"
              onClick={() => setCaptionPreview(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Close Preview
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-slate-400 mb-1">SubRip (.srt)</div>
              <pre className="p-3 bg-[#111724] border border-slate-800 rounded text-[11px] text-slate-300 font-mono overflow-x-auto max-h-48">
                {captionPreview.srt}
              </pre>
            </div>
            <div>
              <div className="text-[11px] text-slate-400 mb-1">SubStation Alpha (.ass)</div>
              <pre className="p-3 bg-[#111724] border border-slate-800 rounded text-[11px] text-slate-300 font-mono overflow-x-auto max-h-48">
                {captionPreview.ass}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
