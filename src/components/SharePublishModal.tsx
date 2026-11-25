import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Send,
  Share2,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AspectRatio,
  ClipCandidate,
  EncodeMode,
  ExportResult,
  ProjectRecord,
  PublishChannelConfig,
  PublishPlatform,
} from '../types';
import {
  apiFetch,
  apiUrl,
  readJsonResponse,
} from '../lib/api';
import {
  buildExportFilename,
  cacheExportInLocalStorage,
  getLocalExport,
  makeLocalExportKey,
} from '../lib/localExports';
import {
  ALL_PLATFORMS,
  PLATFORM_SPECS,
  buildFormattedPostText,
  downloadShareKitPackage,
  ensureThreeTags,
  getPlatformWarnings,
  parseHashtagInput,
  shareViaSystemSheet,
  supportsNativeFileShare,
  supportsNavigatorShare,
  toLocalDatetimeInputValue,
  trimCopyForLimit,
} from '../lib/socialShare';
import { ShareLandingModal, type ShareLandingTarget } from './ShareLandingModal';

interface SharePublishModalProps {
  clip: ClipCandidate;
  project: ProjectRecord;
  aspectRatio: AspectRatio;
  encodeMode: EncodeMode;
  burnCaptions: boolean;
  lastExport: ExportResult | null;
  channels: PublishChannelConfig[];
  onExportCompleted: (result: ExportResult) => void;
  onQueueCompleted: (queuedCount: number, dispatchedNow: boolean) => Promise<void>;
  onClose: () => void;
}

export const SharePublishModal: React.FC<SharePublishModalProps> = ({
  clip,
  project,
  aspectRatio,
  encodeMode,
  burnCaptions,
  lastExport,
  channels,
  onExportCompleted,
  onQueueCompleted,
  onClose,
}) => {
  // Queue / Share Kit state
  const [selectedPlatforms, setSelectedPlatforms] = useState<PublishPlatform[]>(['youtube_shorts']);
  const [previewPlatform, setPreviewPlatform] = useState<PublishPlatform>('youtube_shorts');
  const [caption, setCaption] = useState<string>(() =>
    clip.caption_hook ? `${clip.caption_hook} — ${clip.title}` : clip.title
  );
  const [hashtagInput, setHashtagInput] = useState<string>(() =>
    (clip.tags || []).map((t) => `#${t.replace(/^#+/, '')}`).join(' ')
  );
  const [appendPlatformDefaults, setAppendPlatformDefaults] = useState(true);
  const [scheduleMode, setScheduleMode] = useState<'now' | 'dispatch' | 'later'>('now');
  const [scheduleIso, setScheduleIso] = useState<string>(() =>
    toLocalDatetimeInputValue(Date.now() + 3600_000)
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [instantBusy, setInstantBusy] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [copiedCopy, setCopiedCopy] = useState(false);
  const [landingTarget, setLandingTarget] = useState<ShareLandingTarget | null>(null);

  const clipDurationSec = Math.max(0.5, clip.end_sec - clip.start_sec);
  const parsedUserTags = useMemo(() => parseHashtagInput(hashtagInput), [hashtagInput]);

  const channelMap = useMemo(() => {
    const map = new Map<PublishPlatform, PublishChannelConfig>();
    for (const c of channels) map.set(c.platform, c);
    return map;
  }, [channels]);

  const activePreviewSpec = PLATFORM_SPECS[previewPlatform];
  const previewChannel = channelMap.get(previewPlatform);
  const previewTags = useMemo(
    () =>
      appendPlatformDefaults
        ? ensureThreeTags(
            parsedUserTags,
            previewPlatform,
            previewChannel?.default_hashtags,
            3
          )
        : parsedUserTags,
    [parsedUserTags, previewPlatform, appendPlatformDefaults, previewChannel]
  );
  const previewPostText = useMemo(
    () => buildFormattedPostText(caption, previewTags),
    [caption, previewTags]
  );

  const togglePlatform = (platform: PublishPlatform) => {
    setSelectedPlatforms((prev) => {
      if (prev.includes(platform)) {
        if (prev.length === 1) return prev;
        const next = prev.filter((p) => p !== platform);
        if (previewPlatform === platform) setPreviewPlatform(next[0]);
        return next;
      }
      setPreviewPlatform(platform);
      return [...prev, platform];
    });
  };

  // Ensures rendered MP4 exists on disk AND returns ExportResult + local cached blob if available
  const ensureExportedAsset = async (): Promise<ExportResult> => {
    if (
      lastExport &&
      lastExport.clip_id === clip.id &&
      lastExport.aspect_ratio === aspectRatio
    ) {
      return lastExport;
    }
    const expRes = await apiFetch('/api/clips/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_hash: project.video_hash,
        clip,
        aspect_ratio: aspectRatio,
        encode_mode: encodeMode,
        include_srt: true,
        burn_captions: burnCaptions,
      }),
    });
    const expData = await readJsonResponse<ExportResult>(expRes);
    onExportCompleted(expData);
    try {
      await cacheExportInLocalStorage(project.video_hash, clip.title, expData);
    } catch {
      // Non-fatal if IndexedDB quota is tight
    }
    return expData;
  };

  const handleCopyPostText = async () => {
    try {
      await navigator.clipboard?.writeText(previewPostText);
      setCopiedCopy(true);
      setStatusMessage({
        kind: 'info',
        text: `Copied ${activePreviewSpec.label} caption & hashtags to clipboard.`,
      });
      window.setTimeout(() => setCopiedCopy(false), 1800);
    } catch {
      setStatusMessage({ kind: 'error', text: 'Clipboard access blocked in this context.' });
    }
  };

  const handleDownloadShareKit = async () => {
    setInstantBusy('kit');
    setStatusMessage(null);
    try {
      const exp = await ensureExportedAsset();
      const cached = await getLocalExport(makeLocalExportKey(project.video_hash, exp)).catch(() => null);
      const filename = buildExportFilename(clip.id, exp.aspect_ratio, 'mp4');
      const res = await downloadShareKitPackage({
        filename,
        postText: previewPostText,
        videoBlob: cached?.video_blob || null,
        fallbackMediaUrl: apiUrl(exp.video_url),
      });
      setStatusMessage({
        kind: 'info',
        text: res.copied
          ? `Downloaded ${filename} and copied ${activePreviewSpec.label} post text to clipboard.`
          : `Downloaded ${filename}.`,
      });
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Share kit download failed.' });
    } finally {
      setInstantBusy(null);
    }
  };

  const handleOpenLandingPage = async () => {
    setInstantBusy('launch');
    setStatusMessage(null);
    try {
      const exp = await ensureExportedAsset();
      const cached = await getLocalExport(makeLocalExportKey(project.video_hash, exp)).catch(() => null);
      const scheduledIso =
        scheduleMode === 'later' && scheduleIso && !Number.isNaN(Date.parse(scheduleIso))
          ? new Date(scheduleIso).toISOString()
          : null;

      setLandingTarget({
        clipId: clip.id,
        clipTitle: clip.title,
        videoPath: exp.video_path,
        videoUrl: exp.video_url,
        videoBlob: cached?.video_blob || null,
        aspectRatio: exp.aspect_ratio,
        platform: previewPlatform,
        captionText: caption.trim() || clip.title,
        tags: previewTags,
        scheduledAtIso: scheduledIso,
      });
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Failed to prepare landing page.' });
    } finally {
      setInstantBusy(null);
    }
  };

  const handleNativeShare = async () => {
    setInstantBusy('native');
    setStatusMessage(null);
    try {
      const exp = await ensureExportedAsset();
      const cached = await getLocalExport(makeLocalExportKey(project.video_hash, exp)).catch(() => null);
      const filename = buildExportFilename(clip.id, exp.aspect_ratio, 'mp4');
      const outcome = await shareViaSystemSheet({
        title: clip.title,
        postText: previewPostText,
        filename,
        videoBlob: cached?.video_blob || null,
        fallbackMediaUrl: apiUrl(exp.video_url),
      });
      if (outcome === 'shared-file') {
        setStatusMessage({ kind: 'info', text: 'Shared MP4 clip and post text via System Share Sheet.' });
      } else if (outcome === 'shared-text') {
        setStatusMessage({ kind: 'info', text: 'Shared post copy via System Share Sheet.' });
      }
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Native share failed.' });
    } finally {
      setInstantBusy(null);
    }
  };

  const handleSubmitQueue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedPlatforms.length === 0) return;
    setIsSubmitting(true);
    setStatusMessage(null);
    try {
      const exp = await ensureExportedAsset();
      const scheduledIso =
        scheduleMode === 'later' ? new Date(scheduleIso).toISOString() : null;

      const createdIds: string[] = [];
      for (const platform of selectedPlatforms) {
        const ch = channelMap.get(platform);
        const tagsForPlatform = ensureThreeTags(
          parsedUserTags,
          platform,
          ch?.default_hashtags,
          3
        );
        const captionForPlatform =
          platform === 'x_video'
            ? trimCopyForLimit(caption, tagsForPlatform, PLATFORM_SPECS.x_video.maxChars)
            : caption.trim();

        const res = await apiFetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clip_id: clip.id,
            clip_title: clip.title,
            video_path: exp.video_path,
            srt_path: exp.srt_path,
            platform,
            caption_text: captionForPlatform,
            tags: tagsForPlatform,
            scheduled_at_iso: scheduledIso,
          }),
        });
        const job = await readJsonResponse<{ job_id: string }>(res);
        createdIds.push(job.job_id);
      }

      if (scheduleMode === 'dispatch') {
        for (const jobId of createdIds) {
          await apiFetch(`/api/queue/${encodeURIComponent(jobId)}/dispatch`, {
            method: 'POST',
          });
        }
      }

      await onQueueCompleted(createdIds.length, scheduleMode === 'dispatch');
      onClose();
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Failed to enqueue social share jobs.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const fileShareSupported = supportsNativeFileShare();
  const anyShareSupported = supportsNavigatorShare();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Share & Publish ${clip.id}`}
    >
      <form
        onSubmit={handleSubmitQueue}
        className="w-full max-w-2xl bg-[#111724] border border-slate-700 rounded-lg overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
      >
        <div className="px-5 py-3.5 border-b border-slate-800 bg-[#0B0F17] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">
              Share & Publish Clip · {clip.id}
            </h3>
            <p className="text-[11px] text-slate-400 truncate mt-0.5">
              {clip.title} · {clipDurationSec.toFixed(1)}s · {aspectRatio}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share dialog"
            className="p-1 text-slate-400 hover:text-white rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* Multi-Platform Target Picker */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-slate-300 font-medium">
                    Target Channels ({selectedPlatforms.length} selected)
                  </label>
                  <button
                    type="button"
                    onClick={() => setSelectedPlatforms(ALL_PLATFORMS)}
                    className="text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    Select all 4
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {ALL_PLATFORMS.map((pid) => {
                    const spec = PLATFORM_SPECS[pid];
                    const checked = selectedPlatforms.includes(pid);
                    const ch = channelMap.get(pid);
                    const hasWebhook = Boolean(ch?.endpoint_url && ch.enabled);
                    return (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => togglePlatform(pid)}
                        className={`p-2.5 rounded border text-left transition-colors ${
                          checked
                            ? 'bg-blue-600/20 border-blue-500 text-white'
                            : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold text-xs">{spec.label}</span>
                          <span
                            className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${
                              checked
                                ? 'bg-blue-500 border-blue-400 text-white'
                                : 'border-slate-600'
                            }`}
                          >
                            {checked && <Check className="w-2.5 h-2.5" />}
                          </span>
                        </div>
                        <div className="text-[10px] mt-1 font-mono text-slate-400">
                          {hasWebhook ? 'Webhook connected' : 'Share Kit / Staged'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Caption + Hashtags Editor */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-8 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-300 font-medium">Post Caption / Title</label>
                    {selectedPlatforms.includes('x_video') &&
                      previewPostText.length > PLATFORM_SPECS.x_video.maxChars && (
                        <button
                          type="button"
                          onClick={() =>
                            setCaption((prev) =>
                              trimCopyForLimit(prev, parsedUserTags, PLATFORM_SPECS.x_video.maxChars)
                            )
                          }
                          className="inline-flex items-center gap-1 text-[10px] text-amber-300 hover:text-amber-200"
                        >
                          <Sparkles className="w-3 h-3" />
                          Fit 280c for X
                        </button>
                      )}
                  </div>
                  <textarea
                    rows={3}
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 text-slate-100 outline-none resize-none"
                  />
                </div>

                <div className="sm:col-span-4 space-y-1.5">
                  <label className="text-slate-300 font-medium">Hashtags</label>
                  <textarea
                    rows={3}
                    value={hashtagInput}
                    onChange={(e) => setHashtagInput(e.target.value)}
                    placeholder="#coding #productivity"
                    className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 font-mono text-[11px] text-slate-200 outline-none resize-none"
                  />
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={appendPlatformDefaults}
                      onChange={(e) => setAppendPlatformDefaults(e.target.checked)}
                      className="accent-blue-500"
                    />
                    Auto-add channel tags (#Shorts, #fyp)
                  </label>
                </div>
              </div>

              {/* Per-Platform Preview & Readiness Check */}
              <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-1 bg-[#111724] border border-slate-800 rounded p-0.5">
                    {ALL_PLATFORMS.map((pid) => (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => setPreviewPlatform(pid)}
                        className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                          previewPlatform === pid
                            ? 'bg-slate-800 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {PLATFORM_SPECS[pid].shortLabel}
                      </button>
                    ))}
                  </div>
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      previewPostText.length > activePreviewSpec.maxChars
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {previewPostText.length} / {activePreviewSpec.maxChars} chars
                  </span>
                </div>

                <pre className="text-[11px] text-slate-200 whitespace-pre-wrap font-sans bg-[#111724] border border-slate-800/80 rounded p-2.5 max-h-24 overflow-y-auto">
                  {previewPostText || '(Empty caption)'}
                </pre>

                {(() => {
                  const warnings = getPlatformWarnings(
                    previewPlatform,
                    previewPostText,
                    clipDurationSec,
                    aspectRatio
                  );
                  if (warnings.length === 0) return null;
                  return (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>{warnings.join(' · ')}</span>
                    </div>
                  );
                })()}

                {/* Instant Share Now Row (Opens Pre-Filled Share / Schedule Landing Page) */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                  <button
                    type="button"
                    disabled={instantBusy !== null}
                    onClick={handleOpenLandingPage}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-white font-semibold transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {instantBusy === 'launch'
                      ? 'Preparing Clip...'
                      : scheduleMode === 'later'
                        ? `Open Schedule Landing (${activePreviewSpec.shortLabel})`
                        : `Share & Open ${activePreviewSpec.shortLabel} Landing`}
                  </button>

                  <button
                    type="button"
                    disabled={instantBusy !== null}
                    onClick={handleDownloadShareKit}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 rounded text-blue-300 font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {instantBusy === 'kit' ? 'Preparing MP4...' : 'Download + Copy'}
                  </button>

                  <button
                    type="button"
                    onClick={handleCopyPostText}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-200"
                  >
                    {copiedCopy ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCopy ? 'Copied' : 'Copy Caption'}
                  </button>

                  {anyShareSupported && (
                    <button
                      type="button"
                      disabled={instantBusy !== null}
                      onClick={handleNativeShare}
                      title={
                        fileShareSupported
                          ? 'Share MP4 file directly through OS Share Sheet'
                          : 'Share post copy through OS Share Sheet'
                      }
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-emerald-300 font-medium"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      {instantBusy === 'native'
                        ? 'Opening Share...'
                        : fileShareSupported
                          ? 'OS Share Sheet'
                          : 'Share Text'}
                    </button>
                  )}
                </div>
              </div>

              {/* Queue Dispatch Timing */}
              <div className="space-y-2">
                <label className="block text-slate-300 font-medium">Queue & Dispatch Mode</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setScheduleMode('now')}
                    className={`py-2 px-3 rounded border font-medium text-center ${
                      scheduleMode === 'now'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Save to Queue
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode('dispatch')}
                    className={`py-2 px-3 rounded border font-medium text-center ${
                      scheduleMode === 'dispatch'
                        ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Queue & Publish Now
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode('later')}
                    className={`py-2 px-3 rounded border font-medium text-center ${
                      scheduleMode === 'later'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Schedule Date/Time
                  </button>
                </div>
                {scheduleMode === 'later' && (
                  <input
                    type="datetime-local"
                    value={scheduleIso}
                    onChange={(e) => setScheduleIso(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 font-mono text-slate-100 outline-none focus:border-blue-500"
                  />
                )}
              </div>

          {statusMessage && (
            <div
              className={`px-3 py-2 rounded border text-[11px] ${
                statusMessage.kind === 'error'
                  ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
                  : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              }`}
            >
              {statusMessage.text}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 bg-[#0B0F17] flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">
            {lastExport?.clip_id === clip.id && lastExport?.aspect_ratio === aspectRatio
              ? 'Using existing rendered MP4'
              : `Will render ${aspectRatio} MP4 on submit`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || selectedPlatforms.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              {isSubmitting
                ? 'Rendering & Queuing...'
                : scheduleMode === 'dispatch'
                  ? `Publish to ${selectedPlatforms.length} Channel${selectedPlatforms.length > 1 ? 's' : ''}`
                  : `Add ${selectedPlatforms.length} Job${selectedPlatforms.length > 1 ? 's' : ''} to Queue`}
            </button>
          </div>
        </div>
      </form>

      {landingTarget && (
        <ShareLandingModal
          target={landingTarget}
          channels={channels}
          onClose={() => setLandingTarget(null)}
        />
      )}
    </div>
  );
};
