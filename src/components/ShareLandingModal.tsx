import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Film,
  Hash,
  Plus,
  Send,
  Share2,
  X,
} from 'lucide-react';
import type {
  AspectRatio,
  PublishChannelConfig,
  PublishPlatform,
  PublishStatus,
} from '../types';
import {
  apiUrl,
  isTauriRuntime,
  openExternalBrowserUrl,
} from '../lib/api';
import { findLocalExportByMatch } from '../lib/localExports';
import {
  ALL_PLATFORMS,
  PLATFORM_SPECS,
  buildFormattedPostText,
  downloadShareKitPackage,
  ensureThreeTags,
  getPlatformWarnings,
  openPlatformStudio,
  resolveExportMediaUrlFromPath,
  shareViaSystemSheet,
  supportsNativeFileShare,
  supportsNavigatorShare,
  toLocalDatetimeInputValue,
  trimCopyForLimit,
} from '../lib/socialShare';

export interface ShareLandingTarget {
  jobId?: string;
  clipId: string;
  clipTitle: string;
  videoPath: string;
  videoUrl?: string | null;
  videoBlob?: Blob | null;
  aspectRatio?: AspectRatio;
  platform: PublishPlatform;
  captionText: string;
  tags: string[];
  scheduledAtIso: string | null;
  status?: PublishStatus;
  publishedUrl?: string | null;
}

interface ShareLandingModalProps {
  target: ShareLandingTarget;
  channels: PublishChannelConfig[];
  onUpdateJob?: (
    jobId: string,
    patch: {
      caption_text?: string;
      tags?: string[];
      platform?: PublishPlatform;
      scheduled_at_iso?: string | null;
      clear_schedule?: boolean;
    }
  ) => Promise<void>;
  onDispatchJob?: (jobId: string) => Promise<void>;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatRelativeCountdown(iso: string | null): string {
  if (!iso) return 'Immediate share';
  const targetMs = Date.parse(iso);
  if (Number.isNaN(targetMs)) return 'Scheduled time';
  const diffMin = Math.round((targetMs - Date.now()) / 60_000);
  if (diffMin <= 0) return 'Due now';
  if (diffMin < 60) return `In ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (hours < 24) return mins > 0 ? `In ${hours}h ${mins}m` : `In ${hours}h`;
  const days = Math.floor(hours / 24);
  return `In ${days}d ${hours % 24}h`;
}

export const ShareLandingModal: React.FC<ShareLandingModalProps> = ({
  target,
  channels,
  onUpdateJob,
  onDispatchJob,
  onClose,
}) => {
  const initialChannelDefaults = useMemo(
    () => channels.find((c) => c.platform === target.platform)?.default_hashtags,
    [channels, target.platform]
  );

  // Scheduled posts open directly into Schedule Landing view; unscheduled open in Share Landing view
  const [activeView, setActiveView] = useState<'share' | 'schedule'>(() =>
    target.scheduledAtIso ? 'schedule' : 'share'
  );

  const [platform, setPlatform] = useState<PublishPlatform>(target.platform);
  const [caption, setCaption] = useState<string>(
    () => target.captionText?.trim() || target.clipTitle || 'New Short Clip'
  );
  const [tags, setTags] = useState<string[]>(() =>
    ensureThreeTags(target.tags || [], target.platform, initialChannelDefaults, 3)
  );
  const [newTagInput, setNewTagInput] = useState('');

  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>(() =>
    target.scheduledAtIso ? 'later' : 'now'
  );
  const [scheduleLocal, setScheduleLocal] = useState<string>(() =>
    toLocalDatetimeInputValue(target.scheduledAtIso)
  );

  // Attached video state
  const [resolvedBlob, setResolvedBlob] = useState<Blob | null>(target.videoBlob || null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [videoSizeLabel, setVideoSizeLabel] = useState<string>(() =>
    target.videoBlob ? formatBytes(target.videoBlob.size) : ''
  );
  const [videoLoading, setVideoLoading] = useState<boolean>(!target.videoBlob);
  const [videoError, setVideoError] = useState<string | null>(null);

  // Action feedback
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'caption' | 'tags' | 'full' | null>(null);
  const [banner, setBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [blockedStudioUrl, setBlockedStudioUrl] = useState<{ label: string; url: string } | null>(
    null
  );
  const [publishedResultUrl, setPublishedResultUrl] = useState<string | null>(
    target.publishedUrl || null
  );

  const channelConfig = useMemo(
    () => channels.find((c) => c.platform === platform),
    [channels, platform]
  );
  const hasWebhook = Boolean(channelConfig?.endpoint_url?.trim() && channelConfig.enabled);
  const spec = PLATFORM_SPECS[platform];
  const fullPostText = useMemo(() => buildFormattedPostText(caption, tags), [caption, tags]);
  const hashtagLine = useMemo(
    () =>
      tags
        .map((t) => `#${t.trim().replace(/^#+/, '')}`)
        .filter((t) => t.length > 1)
        .join(' '),
    [tags]
  );

  const scheduledIsoOut = useMemo(() => {
    if (scheduleMode !== 'later' || !scheduleLocal) return null;
    const ms = Date.parse(scheduleLocal);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }, [scheduleMode, scheduleLocal]);

  const warnings = useMemo(
    () => getPlatformWarnings(platform, fullPostText, undefined, target.aspectRatio),
    [platform, fullPostText, target.aspectRatio]
  );

  const fileName = `${target.clipId}_${platform}.mp4`;
  const mediaFallbackUrl = useMemo(() => {
    if (target.videoUrl) return apiUrl(target.videoUrl);
    return resolveExportMediaUrlFromPath(target.videoPath);
  }, [target.videoUrl, target.videoPath]);

  // Attach MP4 automatically on open (IndexedDB local blob first, then /media/exports URL)
  useEffect(() => {
    let active = true;
    let createdObjectUrl: string | null = null;

    const attachMedia = async () => {
      setVideoError(null);
      if (target.videoBlob) {
        createdObjectUrl = URL.createObjectURL(target.videoBlob);
        if (!active) return;
        setResolvedBlob(target.videoBlob);
        setVideoSizeLabel(formatBytes(target.videoBlob.size));
        setPreviewSrc(createdObjectUrl);
        setVideoLoading(false);
        return;
      }

      setVideoLoading(true);
      try {
        const cached = await findLocalExportByMatch(target.clipId, target.videoPath).catch(
          () => null
        );
        if (!active) return;
        if (cached?.video_blob) {
          createdObjectUrl = URL.createObjectURL(cached.video_blob);
          setResolvedBlob(cached.video_blob);
          setVideoSizeLabel(formatBytes(cached.video_blob.size));
          setPreviewSrc(createdObjectUrl);
          setVideoLoading(false);
          return;
        }
      } catch {
        // Fall through to URL playback
      }

      if (mediaFallbackUrl) {
        setPreviewSrc(mediaFallbackUrl);
      } else {
        setVideoError('Exported MP4 file path was not found. Re-export this clip in Clip Studio.');
      }
      setVideoLoading(false);
    };

    attachMedia();

    return () => {
      active = false;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [target.clipId, target.videoPath, target.videoBlob, mediaFallbackUrl]);

  const handlePlatformSwitch = (nextPlatform: PublishPlatform) => {
    setPlatform(nextPlatform);
    const nextChannelDefaults = channels.find(
      (c) => c.platform === nextPlatform
    )?.default_hashtags;
    setTags((prev) => ensureThreeTags(prev, nextPlatform, nextChannelDefaults, 3));
    setBanner(null);
  };

  const handleAddTag = () => {
    const cleaned = newTagInput.trim().replace(/^#+/, '');
    if (!cleaned) return;
    setTags((prev) => {
      if (prev.some((t) => t.toLowerCase() === cleaned.toLowerCase())) return prev;
      return [...prev, cleaned];
    });
    setNewTagInput('');
  };

  const handleRemoveTag = (idx: number) => {
    setTags((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleResetThreeTags = () => {
    setTags(ensureThreeTags([], platform, channelConfig?.default_hashtags, 3));
  };

  const handleCopyText = async (which: 'caption' | 'tags' | 'full') => {
    const text = which === 'caption' ? caption.trim() : which === 'tags' ? hashtagLine : fullPostText;
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(which);
      setBanner({
        kind: 'info',
        text:
          which === 'caption'
            ? 'Copied caption to clipboard.'
            : which === 'tags'
              ? 'Copied 3 hashtags to clipboard.'
              : 'Copied caption + 3 hashtags to clipboard.',
      });
      window.setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setBanner({ kind: 'error', text: 'Clipboard write blocked by browser policy.' });
    }
  };

  const handleDownloadOnly = async () => {
    setBusyAction('download');
    setBanner(null);
    try {
      const res = await downloadShareKitPackage({
        filename: fileName,
        postText: fullPostText,
        videoBlob: resolvedBlob,
        fallbackMediaUrl: mediaFallbackUrl,
      });
      if (res.warning) {
        setBanner({ kind: 'error', text: res.warning });
      } else {
        setBanner({
          kind: 'info',
          text: `Saved ${fileName}${res.copied ? ' and copied caption + 3 hashtags.' : '.'}`,
        });
      }
    } catch (err: any) {
      setBanner({ kind: 'error', text: err?.message || 'Failed to download MP4.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleNativeShare = async () => {
    setBusyAction('native');
    setBanner(null);
    try {
      const outcome = await shareViaSystemSheet({
        title: target.clipTitle,
        postText: fullPostText,
        filename: fileName,
        videoBlob: resolvedBlob,
        fallbackMediaUrl: mediaFallbackUrl,
      });
      if (outcome !== 'cancelled') {
        setBanner({
          kind: 'info',
          text:
            outcome === 'shared-file'
              ? 'Opened OS Share Sheet with MP4 clip + caption + 3 tags attached.'
              : 'Opened OS Share Sheet with caption + 3 tags.',
        });
      }
    } catch (err: any) {
      setBanner({ kind: 'error', text: err?.message || 'System Share Sheet failed.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveChangesToQueue = async () => {
    if (!target.jobId || !onUpdateJob) return;
    setBusyAction('save');
    setBanner(null);
    try {
      await onUpdateJob(target.jobId, {
        platform,
        caption_text: caption.trim(),
        tags,
        scheduled_at_iso: scheduledIsoOut,
        clear_schedule: scheduleMode === 'now',
      });
      setBanner({
        kind: 'info',
        text:
          scheduleMode === 'later' && scheduledIsoOut
            ? `Saved schedule for ${new Date(scheduledIsoOut).toLocaleString()} with ${tags.length} tags.`
            : 'Saved updated caption, tags, and immediate dispatch settings.',
      });
    } catch (err: any) {
      setBanner({ kind: 'error', text: err?.message || 'Failed to update job.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDispatchWebhook = async () => {
    if (!target.jobId || !onDispatchJob) return;
    setBusyAction('webhook');
    setBanner(null);
    try {
      if (onUpdateJob) {
        await onUpdateJob(target.jobId, {
          platform,
          caption_text: caption.trim(),
          tags,
          scheduled_at_iso: scheduledIsoOut,
          clear_schedule: scheduleMode === 'now',
        });
      }
      await onDispatchJob(target.jobId);
      setBanner({
        kind: 'info',
        text: hasWebhook
          ? `Dispatched MP4 + caption + ${tags.length} tags to ${spec.label} webhook.`
          : `Staged ${spec.label} delivery receipt locally.`,
      });
    } catch (err: any) {
      setBanner({ kind: 'error', text: err?.message || 'Webhook dispatch failed.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadCopyAndOpenExternal = async () => {
    setBusyAction('open');
    setBanner(null);
    setBlockedStudioUrl(null);
    const studioUrl = spec.buildStudioUrl(fullPostText);
    const preOpenedTab =
      !isTauriRuntime && typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;

    try {
      // Save any queue edits quietly before launching
      if (target.jobId && onUpdateJob) {
        await onUpdateJob(target.jobId, {
          platform,
          caption_text: caption.trim(),
          tags,
          scheduled_at_iso: scheduledIsoOut,
          clear_schedule: scheduleMode === 'now',
        }).catch(() => undefined);
      }

      const res = await downloadShareKitPackage({
        filename: fileName,
        postText: fullPostText,
        videoBlob: resolvedBlob,
        fallbackMediaUrl: mediaFallbackUrl,
      });

      let opened = false;
      if (isTauriRuntime) {
        opened = await openExternalBrowserUrl(studioUrl);
      } else if (preOpenedTab && !preOpenedTab.closed) {
        preOpenedTab.location.href = studioUrl;
        opened = true;
      }

      if (!opened) {
        setBlockedStudioUrl({ label: spec.uploadLabel, url: studioUrl });
      }

      if (res.warning) {
        setBanner({
          kind: 'error',
          text: `${res.copied ? 'Copied caption + 3 tags. ' : ''}${res.warning}`,
        });
      } else {
        setBanner({
          kind: 'info',
          text:
            platform === 'x_video'
              ? `Opened X Compose with caption + 3 tags pre-filled, and saved ${fileName} to drop in.`
              : opened
                ? `Saved ${fileName} & copied caption + 3 tags to clipboard — drop MP4 into ${spec.label} and press Ctrl+V / Cmd+V.`
                : `Saved ${fileName} & copied caption + 3 tags. Click "${spec.uploadLabel}" below to finish posting.`,
        });
      }
    } catch (err: any) {
      if (preOpenedTab && !preOpenedTab.closed) preOpenedTab.close();
      setBanner({ kind: 'error', text: err?.message || 'Failed to launch share destination.' });
    } finally {
      setBusyAction(null);
    }
  };

  const anyShareSupported = supportsNavigatorShare();
  const fileShareSupported = supportsNativeFileShare();
  const displayFileName = (target.videoPath || fileName).replace(/\\/g, '/').split('/').pop() || fileName;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={
        activeView === 'schedule'
          ? `Schedule Landing — ${target.clipTitle}`
          : `Share Landing — ${target.clipTitle}`
      }
    >
      <div className="w-full max-w-4xl bg-[#111724] border border-slate-800 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Top Bar: Context & Mode Switch */}
        <div className="px-5 py-3.5 bg-[#0B0F17] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100 truncate">
              {activeView === 'schedule' ? 'Scheduled Publish Landing' : 'Social Share Landing'} ·{' '}
              {spec.label}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-0.5 font-mono tabular-nums">
              <span>{target.clipId}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate max-w-[240px]">{displayFileName}</span>
              {videoSizeLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{videoSizeLabel}</span>
                </>
              )}
              {scheduleMode === 'later' && scheduledIsoOut && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-300">
                    {formatRelativeCountdown(scheduledIsoOut)}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Segmented View Switch */}
            <div className="inline-flex items-center gap-1 p-0.5 bg-[#111724] border border-slate-800 rounded">
              <button
                type="button"
                onClick={() => setActiveView('share')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  activeView === 'share'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Share Details
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveView('schedule');
                  if (scheduleMode === 'now') {
                    setScheduleMode('later');
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  activeView === 'schedule'
                    ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <CalendarClock className="w-3.5 h-3.5" />
                Schedule Details
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close landing page"
              className="p-1.5 text-slate-400 hover:text-white rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main Two-Column Content */}
        <div className="p-5 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs flex-1">
          {/* Left Column: Already Attached Video Clip */}
          <div className="lg:col-span-5 flex flex-col gap-3">
            <div className="flex items-center justify-between text-[11px] text-slate-300 font-medium">
              <span className="inline-flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-emerald-400" />
                Attached Clip
              </span>
              <span className="font-mono tabular-nums text-emerald-400">
                {videoLoading
                  ? 'Attaching...'
                  : previewSrc && !videoError
                    ? 'Attached & ready'
                    : 'Missing file'}
              </span>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-md overflow-hidden aspect-[9/16] max-h-[380px] flex items-center justify-center relative">
              {previewSrc && !videoError ? (
                <video
                  src={previewSrc}
                  controls
                  playsInline
                  preload="metadata"
                  onError={() =>
                    setVideoError(
                      'Browser could not stream this MP4 directly here. Use Download MP4 or re-export the clip.'
                    )
                  }
                  className="w-full h-full object-contain bg-black"
                />
              ) : (
                <div className="p-5 text-center space-y-2 text-slate-400">
                  <Film className="w-7 h-7 mx-auto text-slate-600" />
                  <p className="text-xs text-slate-300">
                    {videoLoading ? 'Loading attached MP4 clip...' : videoError || 'Clip unavailable'}
                  </p>
                </div>
              )}
            </div>

            {/* Direct File Utility Actions */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleDownloadOnly}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#0B0F17] hover:bg-slate-800 border border-slate-700 rounded text-slate-200 font-medium whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                {busyAction === 'download' ? 'Saving...' : 'Download MP4'}
              </button>

              {anyShareSupported ? (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={handleNativeShare}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#0B0F17] hover:bg-slate-800 border border-slate-700 rounded text-emerald-300 font-medium whitespace-nowrap"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  {fileShareSupported ? 'OS Share Sheet' : 'Share Copy'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleCopyText('full')}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#0B0F17] hover:bg-slate-800 border border-slate-700 rounded text-slate-200 font-medium whitespace-nowrap"
                >
                  {copiedKey === 'full' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copiedKey === 'full' ? 'Copied All' : 'Copy Post + Tags'}
                </button>
              )}
            </div>
          </div>

          {/* Right Column: Caption, 3 Tags, Schedule Details & Publish Controls */}
          <div className="lg:col-span-7 space-y-4">
            {/* Target Platform Selector */}
            <div className="space-y-1.5">
              <label className="block text-slate-400 font-medium">Destination Channel</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {ALL_PLATFORMS.map((pid) => {
                  const active = platform === pid;
                  return (
                    <button
                      key={pid}
                      type="button"
                      onClick={() => handlePlatformSwitch(pid)}
                      className={`px-2.5 py-2 rounded border text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        active
                          ? 'bg-blue-600/20 border-blue-500 text-white'
                          : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {PLATFORM_SPECS[pid].shortLabel}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Schedule Landing Panel (auto-expanded when opened on a scheduled post) */}
            {activeView === 'schedule' && (
              <div className="bg-[#0B0F17] border border-amber-500/35 rounded-md p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800">
                  <div className="flex items-center gap-2 text-amber-300 font-semibold">
                    <CalendarClock className="w-4 h-4" />
                    <span>Scheduled Publish Details</span>
                  </div>
                  <span className="font-mono tabular-nums text-[11px] text-slate-300">
                    {scheduleMode === 'later' && scheduledIsoOut
                      ? new Date(scheduledIsoOut).toLocaleString()
                      : 'Immediate'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                  <div className="sm:col-span-5 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setScheduleMode('later')}
                      className={`py-1.5 px-2 rounded border font-medium whitespace-nowrap ${
                        scheduleMode === 'later'
                          ? 'bg-amber-500/20 border-amber-500 text-amber-200'
                          : 'bg-[#111724] border-slate-800 text-slate-400'
                      }`}
                    >
                      Scheduled
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleMode('now')}
                      className={`py-1.5 px-2 rounded border font-medium whitespace-nowrap ${
                        scheduleMode === 'now'
                          ? 'bg-blue-600/20 border-blue-500 text-white'
                          : 'bg-[#111724] border-slate-800 text-slate-400'
                      }`}
                    >
                      Post Now
                    </button>
                  </div>

                  <div className="sm:col-span-7">
                    <input
                      type="datetime-local"
                      disabled={scheduleMode !== 'later'}
                      value={scheduleLocal}
                      onChange={(e) => {
                        setScheduleMode('later');
                        setScheduleLocal(e.target.value);
                      }}
                      className="w-full bg-[#111724] border border-slate-800 focus:border-amber-500 disabled:opacity-45 rounded px-3 py-1.5 font-mono tabular-nums text-slate-100 outline-none"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                  <span>
                    {hasWebhook
                      ? 'Webhook connector will auto-trigger at the scheduled time when Queue runs.'
                      : 'Save schedule to queue or download now and set the schedule time inside the platform app.'}
                  </span>
                  {target.jobId && onUpdateJob && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={handleSaveChangesToQueue}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-medium rounded whitespace-nowrap shrink-0"
                    >
                      {busyAction === 'save' ? 'Saving...' : 'Save Schedule'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Pre-Written Caption */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-slate-300 font-medium">
                  Caption / {platform === 'youtube_shorts' ? 'Shorts Title' : 'Post Copy'}
                </label>
                <div className="flex items-center gap-3">
                  {platform === 'x_video' && fullPostText.length > spec.maxChars && (
                    <button
                      type="button"
                      onClick={() =>
                        setCaption((prev) => trimCopyForLimit(prev, tags, spec.maxChars))
                      }
                      className="text-[11px] text-amber-300 hover:text-amber-200"
                    >
                      Trim to 280c
                    </button>
                  )}
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      fullPostText.length > spec.maxChars ? 'text-amber-400' : 'text-slate-400'
                    }`}
                  >
                    {fullPostText.length} / {spec.maxChars}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyText('caption')}
                    className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    {copiedKey === 'caption' ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copiedKey === 'caption' ? 'Copied' : 'Copy Caption'}
                  </button>
                </div>
              </div>
              <textarea
                rows={3}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write or refine your hook caption..."
                className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 text-slate-100 outline-none resize-none leading-relaxed"
              />
            </div>

            {/* 3 Curated Hashtags */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-slate-300 font-medium">
                  <Hash className="w-3.5 h-3.5 text-blue-400" />
                  Hashtags ({tags.length} included)
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleResetThreeTags}
                    className="text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    Reset 3 defaults
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyText('tags')}
                    className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    {copiedKey === 'tags' ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copiedKey === 'tags' ? 'Copied' : 'Copy Tags'}
                  </button>
                </div>
              </div>

              <div className="bg-[#0B0F17] border border-slate-800 rounded p-2.5 space-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-xs">
                  {tags.map((tag, idx) => (
                    <span
                      key={`${tag}-${idx}`}
                      className="inline-flex items-center gap-1 text-blue-300"
                    >
                      <span>#{tag}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(idx)}
                        aria-label={`Remove #${tag}`}
                        className="text-slate-500 hover:text-rose-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {tags.length === 0 && (
                    <span className="text-slate-500 font-sans text-[11px]">
                      No tags selected. Add up to 3 tags below.
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                  <input
                    type="text"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    placeholder="Add hashtag (e.g. productivity)"
                    className="flex-1 bg-[#111724] border border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded text-[11px] font-medium whitespace-nowrap"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                </div>
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="flex items-center gap-2 text-[11px] text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{warnings.join(' · ')}</span>
              </div>
            )}

            {/* Ready-to-Post Combined Preview */}
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Ready-to-Paste Post Copy</span>
                <button
                  type="button"
                  onClick={() => handleCopyText('full')}
                  className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-medium"
                >
                  {copiedKey === 'full' ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  {copiedKey === 'full' ? 'Copied All' : 'Copy Full Post'}
                </button>
              </div>
              <pre className="text-[11px] text-slate-200 whitespace-pre-wrap font-sans max-h-24 overflow-y-auto leading-relaxed">
                {fullPostText}
              </pre>
            </div>

            {/* Delivery Actions (Webhook / External Studio Launch) */}
            <div className="space-y-2.5 pt-1">
              {target.jobId && onDispatchJob && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleDispatchWebhook}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#0B0F17] hover:bg-slate-800 border border-slate-700 text-slate-200 font-medium rounded transition-colors whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {busyAction === 'webhook'
                      ? 'Dispatching...'
                      : hasWebhook
                        ? 'Dispatch via Webhook'
                        : 'Mark Staged Receipt'}
                  </button>
                </div>
              )}

              <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleDownloadCopyAndOpenExternal}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {busyAction === 'open'
                      ? 'Preparing MP4 & Copy...'
                      : `Download Clip, Copy Post + ${tags.length} Tags & ${spec.uploadLabel}`}
                  </button>

                  <button
                    type="button"
                    onClick={() => openPlatformStudio(spec.buildStudioUrl(fullPostText))}
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-slate-300 hover:text-white text-[11px] whitespace-nowrap"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open {spec.shortLabel} Only
                  </button>
                </div>

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  {platform === 'x_video'
                    ? 'Clicking above opens X with your caption & 3 tags pre-filled and downloads the MP4 so you can attach it.'
                    : `Browsers restrict websites from attaching local MP4 files into external domains like ${spec.label}. Clicking above downloads your MP4, copies your caption + 3 tags, and opens ${spec.label} so you can drop the file and paste (Ctrl+V / Cmd+V).`}
                </p>

                {blockedStudioUrl && (
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-800 text-[11px] text-amber-200">
                    <span>Popup blocked automatically opening {spec.label}.</span>
                    <a
                      href={blockedStudioUrl.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded shrink-0"
                    >
                      <ExternalLink className="w-3 h-3" />
                      {blockedStudioUrl.label}
                    </a>
                  </div>
                )}
              </div>

              {publishedResultUrl && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-950/35 border border-emerald-500/40 rounded text-[11px] text-emerald-200">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Posted link available:
                  </span>
                  <a
                    href={publishedResultUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-300 hover:text-white underline truncate max-w-[300px]"
                  >
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    {publishedResultUrl}
                  </a>
                </div>
              )}
            </div>

            {banner && (
              <div
                className={`px-3 py-2 rounded border text-[11px] flex items-center justify-between gap-2 ${
                  banner.kind === 'error'
                    ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
                    : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                }`}
              >
                <span>{banner.text}</span>
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="text-slate-400 hover:text-white shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
