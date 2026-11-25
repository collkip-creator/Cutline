import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  PlayCircle,
  Plug,
  RefreshCw,
  RotateCcw,
  Send,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  PublishChannelConfig,
  PublishJob,
  PublishPlatform,
  PublishStatus,
} from '../types';
import { findLocalExportByMatch } from '../lib/localExports';
import {
  ALL_PLATFORMS,
  PLATFORM_SPECS,
  buildFormattedPostText,
  downloadShareKitPackage,
  parseHashtagInput,
  resolveExportMediaUrlFromPath,
  shareViaSystemSheet,
  supportsNavigatorShare,
} from '../lib/socialShare';
import { ShareLandingModal } from './ShareLandingModal';

interface PublishQueueViewProps {
  jobs: PublishJob[];
  channels: PublishChannelConfig[];
  onRefresh: () => Promise<void>;
  onProcessDue: (includeFuture: boolean) => Promise<void>;
  onDispatchJob: (jobId: string) => Promise<void>;
  onUpdateJob: (
    jobId: string,
    patch: {
      caption_text?: string;
      tags?: string[];
      platform?: PublishPlatform;
      scheduled_at_iso?: string | null;
      clear_schedule?: boolean;
    }
  ) => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onDeleteJob: (jobId: string) => Promise<void>;
  onSaveChannel: (
    platform: PublishPlatform,
    payload: {
      enabled: boolean;
      endpoint_url: string;
      bearer_token?: string;
      payload_mode: 'multipart' | 'json';
      default_hashtags: string[];
    }
  ) => Promise<void>;
  onTestChannel: (
    platform: PublishPlatform,
    payload: { endpoint_url?: string; bearer_token?: string }
  ) => Promise<{ ok: boolean; status_code: number | null; message: string }>;
}

const STATUS_DISPLAY: Record<PublishStatus, { label: string; colorClass: string }> = {
  queued: { label: 'Queued', colorClass: 'text-blue-400' },
  scheduled: { label: 'Scheduled', colorClass: 'text-amber-400' },
  publishing: { label: 'Publishing', colorClass: 'text-blue-300' },
  published: { label: 'Published', colorClass: 'text-emerald-400' },
  failed: { label: 'Failed', colorClass: 'text-rose-400' },
  cancelled: { label: 'Cancelled', colorClass: 'text-slate-500' },
};

export const PublishQueueView: React.FC<PublishQueueViewProps> = ({
  jobs,
  channels,
  onRefresh,
  onProcessDue,
  onDispatchJob,
  onUpdateJob,
  onRetryJob,
  onDeleteJob,
  onSaveChannel,
  onTestChannel,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | PublishStatus>('all');
  const [isProcessing, setIsProcessing] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [showConnectors, setShowConnectors] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<PublishPlatform>('youtube_shorts');
  const [actionBanner, setActionBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);

  // Connector editor local state
  const [connEnabled, setConnEnabled] = useState(true);
  const [connUrl, setConnUrl] = useState('');
  const [connToken, setConnToken] = useState('');
  const [connClearToken, setConnClearToken] = useState(false);
  const [connPayloadMode, setConnPayloadMode] = useState<'multipart' | 'json'>('multipart');
  const [connHashtags, setConnHashtags] = useState('');
  const [connBusy, setConnBusy] = useState<'save' | 'test' | null>(null);
  const [connResult, setConnResult] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Inline Job Editor Modal
  const [editingJob, setEditingJob] = useState<PublishJob | null>(null);
  const [editPlatform, setEditPlatform] = useState<PublishPlatform>('youtube_shorts');
  const [editCaption, setEditCaption] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editScheduleMode, setEditScheduleMode] = useState<'now' | 'later'>('now');
  const [editScheduleIso, setEditScheduleIso] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Pre-filled Share / Schedule Landing Modal
  const [landingJobId, setLandingJobId] = useState<string | null>(null);
  const landingJob = useMemo(
    () => (landingJobId ? jobs.find((j) => j.job_id === landingJobId) || null : null),
    [landingJobId, jobs]
  );

  const channelMap = useMemo(() => {
    const map = new Map<PublishPlatform, PublishChannelConfig>();
    for (const c of channels) map.set(c.platform, c);
    return map;
  }, [channels]);

  const configuredWebhooksCount = useMemo(
    () => channels.filter((c) => Boolean(c.endpoint_url?.trim()) && c.enabled).length,
    [channels]
  );

  // Sync connector editor state when switching platform or channels reload
  useEffect(() => {
    const cfg = channelMap.get(selectedConnector);
    if (!cfg) return;
    setConnEnabled(cfg.enabled);
    setConnUrl(cfg.endpoint_url || '');
    setConnToken('');
    setConnClearToken(false);
    setConnPayloadMode(cfg.payload_mode || 'multipart');
    setConnHashtags((cfg.default_hashtags || []).map((t) => `#${t}`).join(' '));
    setConnResult(null);
  }, [selectedConnector, channelMap]);

  const filtered = statusFilter === 'all' ? jobs : jobs.filter((j) => j.status === statusFilter);

  const counts = {
    all: jobs.length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    scheduled: jobs.filter((j) => j.status === 'scheduled').length,
    published: jobs.filter((j) => j.status === 'published').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
  };

  const handleSaveConnector = async () => {
    setConnBusy('save');
    setConnResult(null);
    try {
      await onSaveChannel(selectedConnector, {
        enabled: connEnabled,
        endpoint_url: connUrl.trim(),
        bearer_token: connClearToken ? '' : connToken.trim() ? connToken.trim() : undefined,
        payload_mode: connPayloadMode,
        default_hashtags: parseHashtagInput(connHashtags),
      });
      setConnToken('');
      setConnClearToken(false);
      setConnResult({
        kind: 'info',
        text: connUrl.trim()
          ? `Saved ${PLATFORM_SPECS[selectedConnector].label} webhook (${connPayloadMode}).`
          : `Saved ${PLATFORM_SPECS[selectedConnector].label} settings (local Share Kit mode).`,
      });
    } catch (err: any) {
      setConnResult({ kind: 'error', text: err?.message || 'Failed to save connector settings.' });
    } finally {
      setConnBusy(null);
    }
  };

  const handleTestConnector = async () => {
    setConnBusy('test');
    setConnResult(null);
    try {
      const res = await onTestChannel(selectedConnector, {
        endpoint_url: connUrl.trim() || undefined,
        bearer_token: connToken.trim() ? connToken.trim() : undefined,
      });
      setConnResult({ kind: res.ok ? 'info' : 'error', text: res.message });
    } catch (err: any) {
      setConnResult({ kind: 'error', text: err?.message || 'Webhook ping failed.' });
    } finally {
      setConnBusy(null);
    }
  };

  const handleCopyJobPost = async (job: PublishJob) => {
    const postText = buildFormattedPostText(job.caption_text, job.tags);
    try {
      await navigator.clipboard?.writeText(postText);
      setCopiedJobId(job.job_id);
      setActionBanner({
        kind: 'info',
        text: `Copied formatted ${PLATFORM_SPECS[job.platform]?.label || job.platform} post copy for ${job.clip_id}.`,
      });
      window.setTimeout(() => setCopiedJobId(null), 1800);
    } catch {
      setActionBanner({ kind: 'error', text: 'Clipboard write was blocked by browser policy.' });
    }
  };

  const handleJobShareKit = async (job: PublishJob) => {
    setBusyJobId(`kit-${job.job_id}`);
    setActionBanner(null);
    const postText = buildFormattedPostText(job.caption_text, job.tags);
    try {
      const cached = await findLocalExportByMatch(job.clip_id, job.video_path).catch(() => null);
      const mediaUrl = resolveExportMediaUrlFromPath(job.video_path);
      const fileName = `${job.clip_id}_${job.platform}.mp4`;
      const result = await downloadShareKitPackage({
        filename: fileName,
        postText,
        videoBlob: cached?.video_blob || null,
        fallbackMediaUrl: mediaUrl,
      });

      if (result.warning) {
        setActionBanner({
          kind: 'error',
          text: `${result.copied ? 'Copied caption to clipboard. ' : ''}${result.warning}`,
        });
      } else {
        setActionBanner({
          kind: 'info',
          text: result.downloaded
            ? `Saved ${fileName}${result.copied ? ' and copied caption + hashtags' : ''}.`
            : result.copied
              ? 'Copied caption + hashtags to clipboard.'
              : 'Ready to share.',
        });
      }
    } catch (err: any) {
      setActionBanner({ kind: 'error', text: err?.message || 'Failed to prepare share kit.' });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleJobNativeShare = async (job: PublishJob) => {
    setBusyJobId(`share-${job.job_id}`);
    setActionBanner(null);
    try {
      const postText = buildFormattedPostText(job.caption_text, job.tags);
      const cached = await findLocalExportByMatch(job.clip_id, job.video_path).catch(() => null);
      const mediaUrl = resolveExportMediaUrlFromPath(job.video_path);
      const outcome = await shareViaSystemSheet({
        title: job.clip_title,
        postText,
        filename: `${job.clip_id}_${job.platform}.mp4`,
        videoBlob: cached?.video_blob || null,
        fallbackMediaUrl: mediaUrl,
      });
      if (outcome !== 'cancelled') {
        setActionBanner({
          kind: 'info',
          text:
            outcome === 'shared-file'
              ? `Shared ${job.clip_id} video via System Share Sheet.`
              : `Shared post text via System Share Sheet.`,
        });
      }
    } catch (err: any) {
      setActionBanner({ kind: 'error', text: err?.message || 'Native share failed.' });
    } finally {
      setBusyJobId(null);
    }
  };

  const openEditJob = (job: PublishJob) => {
    setEditingJob(job);
    setEditPlatform(job.platform);
    setEditCaption(job.caption_text);
    setEditTags(job.tags.map((t) => `#${t}`).join(' '));
    if (job.scheduled_at_iso) {
      setEditScheduleMode('later');
      setEditScheduleIso(new Date(job.scheduled_at_iso).toISOString().slice(0, 16));
    } else {
      setEditScheduleMode('now');
      setEditScheduleIso(new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
    }
  };

  const handleSaveJobEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingJob) return;
    setIsSavingEdit(true);
    try {
      await onUpdateJob(editingJob.job_id, {
        platform: editPlatform,
        caption_text: editCaption.trim(),
        tags: parseHashtagInput(editTags),
        scheduled_at_iso:
          editScheduleMode === 'later' && editScheduleIso
            ? new Date(editScheduleIso).toISOString()
            : null,
        clear_schedule: editScheduleMode === 'now',
      });
      setEditingJob(null);
      setActionBanner({ kind: 'info', text: `Updated ${editingJob.job_id}.` });
    } catch (err: any) {
      setActionBanner({ kind: 'error', text: err?.message || 'Failed to update queue job.' });
    } finally {
      setIsSavingEdit(false);
    }
  };

  const nativeShareAvailable = supportsNavigatorShare();

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Social Share & Scheduled Publish Queue
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Local SQLite queue ({configuredWebhooksCount}/4 webhook connectors active) · Supports
            multipart MP4 webhooks, OS Share Sheet, and direct Share Kits.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowConnectors((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors whitespace-nowrap shrink-0 ${
              showConnectors
                ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                : 'bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            <Plug className="w-3.5 h-3.5" />
            Webhook Connectors ({configuredWebhooksCount})
          </button>
          <button
            type="button"
            onClick={() => onRefresh()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={async () => {
              setIsProcessing(true);
              await onProcessDue(false);
              setIsProcessing(false);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap shrink-0"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            {isProcessing ? 'Processing...' : 'Run Due Jobs'}
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={async () => {
              setIsProcessing(true);
              await onProcessDue(true);
              setIsProcessing(false);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <CalendarClock className="w-3.5 h-3.5" />
            Force Run Scheduled
          </button>
        </div>
      </div>

      {/* Collapsible Webhook & Automation Connectors Panel */}
      {showConnectors && (
        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Channel Webhook & Upload Automation Settings
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Connect an n8n, Make, Zapier, Discord, or custom upload API endpoint. Leaving URL
                empty stages clips locally so you can share via Share Kit or OS Share Sheet.
              </p>
            </div>
            <div className="inline-flex items-center gap-1 bg-[#0B0F17] border border-slate-800 rounded p-1">
              {ALL_PLATFORMS.map((pid) => {
                const cfg = channelMap.get(pid);
                const connected = Boolean(cfg?.endpoint_url && cfg.enabled);
                return (
                  <button
                    key={pid}
                    type="button"
                    onClick={() => setSelectedConnector(pid)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      selectedConnector === pid
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {PLATFORM_SPECS[pid].shortLabel}
                    {connected && <span className="ml-1.5 text-emerald-400">●</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">
            <div className="md:col-span-5 space-y-1">
              <label className="block text-slate-400">
                {PLATFORM_SPECS[selectedConnector].label} Webhook / Upload URL
              </label>
              <input
                type="url"
                value={connUrl}
                onChange={(e) => setConnUrl(e.target.value)}
                placeholder="https://n8n.local/webhook/cutline-shorts"
                className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 font-mono text-[11px] text-slate-100 outline-none"
              />
            </div>

            <div className="md:col-span-3 space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-slate-400">Bearer Token (optional)</label>
                {channelMap.get(selectedConnector)?.has_token && !connClearToken && (
                  <button
                    type="button"
                    onClick={() => setConnClearToken(true)}
                    className="text-[10px] text-rose-400 hover:text-rose-300"
                  >
                    Clear saved token
                  </button>
                )}
              </div>
              <input
                type="password"
                value={connToken}
                onChange={(e) => {
                  setConnToken(e.target.value);
                  setConnClearToken(false);
                }}
                placeholder={
                  channelMap.get(selectedConnector)?.has_token && !connClearToken
                    ? `Saved (${channelMap.get(selectedConnector)?.token_preview})`
                    : 'Optional secret token'
                }
                className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 font-mono text-[11px] text-slate-100 outline-none"
              />
            </div>

            <div className="md:col-span-2 space-y-1">
              <label className="block text-slate-400">Payload Mode</label>
              <select
                value={connPayloadMode}
                onChange={(e) => setConnPayloadMode(e.target.value as 'multipart' | 'json')}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-2 text-slate-100 outline-none focus:border-blue-500"
              >
                <option value="multipart">Multipart MP4</option>
                <option value="json">JSON Metadata</option>
              </select>
            </div>

            <div className="md:col-span-2 space-y-1">
              <label className="block text-slate-400">Default Hashtags</label>
              <input
                type="text"
                value={connHashtags}
                onChange={(e) => setConnHashtags(e.target.value)}
                placeholder="#Shorts"
                className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-2.5 py-2 font-mono text-[11px] text-slate-100 outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={connEnabled}
                onChange={(e) => setConnEnabled(e.target.checked)}
                className="accent-blue-500"
              />
              Channel enabled for webhook dispatch
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={connBusy !== null || !connUrl.trim()}
                onClick={handleTestConnector}
                className="px-3 py-1.5 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 disabled:opacity-40 text-slate-200 border border-slate-700 rounded transition-colors"
              >
                {connBusy === 'test' ? 'Pinging...' : 'Test Ping'}
              </button>
              <button
                type="button"
                disabled={connBusy !== null}
                onClick={handleSaveConnector}
                className="px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
              >
                {connBusy === 'save' ? 'Saving...' : 'Save Connector'}
              </button>
            </div>
          </div>

          {connResult && (
            <div
              className={`px-3 py-2 rounded border text-xs ${
                connResult.kind === 'error'
                  ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
                  : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              }`}
            >
              {connResult.text}
            </div>
          )}

          <div className="bg-[#0B0F17] border border-slate-800/80 rounded p-2.5 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300">Webhook Payload (Free self-hosted n8n / Make / Zapier):</span>{' '}
            Multipart POST sends binary <code className="text-slate-200">video</code> (.mp4) +{' '}
            <code className="text-slate-200">subtitles</code> (.srt) along with{' '}
            <code className="text-slate-200">platform</code>, <code className="text-slate-200">title</code>,{' '}
            <code className="text-slate-200">caption</code>, <code className="text-slate-200">tags_json</code>, and{' '}
            <code className="text-slate-200">full_post_text</code>.
          </div>
        </div>
      )}

      {actionBanner && (
        <div
          className={`px-3.5 py-2.5 rounded border text-xs flex items-center justify-between gap-3 ${
            actionBanner.kind === 'error'
              ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
              : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
          }`}
        >
          <span>{actionBanner.text}</span>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-slate-400 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Filter Bar (Segmented Controls) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-[#111724] border border-slate-800 rounded-md">
          {(['all', 'queued', 'scheduled', 'published', 'failed'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab === 'all' ? 'All' : STATUS_DISPLAY[tab].label}{' '}
              <span className="font-mono tabular-nums text-slate-400 ml-1">
                {counts[tab]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Queue Data Table */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center space-y-2">
            <p className="text-sm font-medium text-slate-200">No jobs in this queue filter</p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Select any clip in Clip Studio and click Queue Post to batch-schedule, download a
              Share Kit, or dispatch via webhook.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0D121D] text-[11px] font-medium text-slate-400">
                  <th className="py-2.5 px-3">Job ID</th>
                  <th className="py-2.5 px-3">Clip & Post Copy</th>
                  <th className="py-2.5 px-3">Channel</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Schedule / Receipt</th>
                  <th className="py-2.5 px-3 text-right">Attempts</th>
                  <th className="py-2.5 px-3 text-right">Share & Queue Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {filtered.map((job) => {
                  const st = STATUS_DISPLAY[job.status];
                  const spec = PLATFORM_SPECS[job.platform];
                  const fullCopy = buildFormattedPostText(job.caption_text, job.tags);
                  const ch = channelMap.get(job.platform);
                  const hasWebhook = Boolean(ch?.endpoint_url && ch.enabled);
                  const canDispatch =
                    job.status === 'queued' ||
                    job.status === 'scheduled' ||
                    job.status === 'failed';

                  return (
                    <tr key={job.job_id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-3 font-mono tabular-nums text-slate-300 align-top">
                        {job.job_id}
                      </td>
                      <td className="py-3 px-3 align-top max-w-xs">
                        <div className="font-medium text-slate-100 truncate">{job.clip_title}</div>
                        <div className="text-slate-400 truncate mt-0.5">{job.caption_text}</div>
                        {job.tags.length > 0 && (
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                            {job.tags.map((t) => `#${t}`).join(' ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-200 align-top whitespace-nowrap">
                        <div>{spec?.label || job.platform}</div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          {hasWebhook ? 'Webhook' : 'Local / Share Kit'}
                        </div>
                      </td>
                      <td className="py-3 px-3 align-top whitespace-nowrap">
                        <span className={`font-semibold ${st.colorClass}`}>{st.label}</span>
                        {job.error_message && (
                          <div className="text-[11px] text-rose-400 mt-1 max-w-[220px] whitespace-normal">
                            {job.error_message}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-[11px] text-slate-300 align-top">
                        <div>
                          {job.scheduled_at_iso
                            ? new Date(job.scheduled_at_iso).toLocaleString()
                            : 'Immediate dispatch'}
                        </div>
                        {job.published_url && (
                          <div
                            className="text-emerald-400 truncate max-w-[220px] mt-0.5"
                            title={job.published_url}
                          >
                            {job.published_url}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300 align-top">
                        {job.attempts}
                      </td>
                      <td className="py-3 px-3 text-right align-top">
                        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          {canDispatch && (
                            <button
                              type="button"
                              disabled={busyJobId === `dispatch-${job.job_id}`}
                              onClick={async () => {
                                setBusyJobId(`dispatch-${job.job_id}`);
                                await onDispatchJob(job.job_id);
                                setBusyJobId(null);
                              }}
                              title={
                                hasWebhook
                                  ? 'Send MP4 + caption to configured webhook now'
                                  : 'Verify MP4 on disk and mark staged receipt'
                              }
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 text-blue-300 rounded"
                            >
                              <Send className="w-3 h-3" />
                              {busyJobId === `dispatch-${job.job_id}` ? '...' : 'Publish'}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => handleCopyJobPost(job)}
                            title="Copy caption & hashtags"
                            className="p-1.5 text-slate-300 hover:text-white bg-[#0B0F17] border border-slate-800 rounded"
                          >
                            {copiedJobId === job.job_id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            disabled={busyJobId === `kit-${job.job_id}`}
                            onClick={() => handleJobShareKit(job)}
                            title="Copy post text + Download MP4"
                            className="p-1.5 text-slate-300 hover:text-white bg-[#0B0F17] border border-slate-800 rounded"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>

                          {nativeShareAvailable && (
                            <button
                              type="button"
                              disabled={busyJobId === `share-${job.job_id}`}
                              onClick={() => handleJobNativeShare(job)}
                              title="Share via System Share Sheet"
                              className="p-1.5 text-emerald-400 hover:text-emerald-300 bg-[#0B0F17] border border-slate-800 rounded"
                            >
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {spec && (
                            <button
                              type="button"
                              onClick={() => setLandingJobId(job.job_id)}
                              title={
                                job.scheduled_at_iso
                                  ? 'Open pre-filled Schedule Landing with clip, caption & 3 tags'
                                  : 'Open pre-filled Share Landing with clip, caption & 3 tags'
                              }
                              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border whitespace-nowrap ${
                                job.scheduled_at_iso
                                  ? 'text-amber-200 hover:text-white bg-amber-500/15 hover:bg-amber-500/30 border-amber-500/40'
                                  : 'text-emerald-300 hover:text-white bg-emerald-600/15 hover:bg-emerald-600/30 border-emerald-500/35'
                              }`}
                            >
                              {job.scheduled_at_iso ? (
                                <CalendarClock className="w-3 h-3" />
                              ) : (
                                <ExternalLink className="w-3 h-3" />
                              )}
                              {job.scheduled_at_iso ? 'Schedule & Open' : 'Share & Open'}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openEditJob(job)}
                            title="Edit caption, tags, or schedule"
                            className="p-1.5 text-slate-300 hover:text-white bg-[#0B0F17] border border-slate-800 rounded"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>

                          {job.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => onRetryJob(job.job_id)}
                              title="Reset to queued"
                              className="p-1.5 text-amber-300 hover:text-amber-200 bg-[#0B0F17] border border-slate-800 rounded"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => onDeleteJob(job.job_id)}
                            title="Delete job"
                            className="p-1.5 text-slate-400 hover:text-rose-400 bg-[#0B0F17] border border-slate-800 rounded"
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
      </div>

      {/* Inline Job Edit Modal */}
      {editingJob && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editingJob.job_id}`}
        >
          <form
            onSubmit={handleSaveJobEdit}
            className="w-full max-w-md bg-[#111724] border border-slate-700 rounded-lg p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100">
                Edit Publish Job · {editingJob.job_id}
              </h3>
              <button
                type="button"
                onClick={() => setEditingJob(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-400 mb-1">Channel</label>
                <select
                  value={editPlatform}
                  onChange={(e) => setEditPlatform(e.target.value as PublishPlatform)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                >
                  {ALL_PLATFORMS.map((pid) => (
                    <option key={pid} value={pid}>
                      {PLATFORM_SPECS[pid].label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Post Caption</label>
                <textarea
                  rows={3}
                  value={editCaption}
                  onChange={(e) => setEditCaption(e.target.value)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 text-slate-100 outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Hashtags</label>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="#Shorts #ai"
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 font-mono text-slate-100 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Schedule</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setEditScheduleMode('now')}
                    className={`py-1.5 rounded border font-medium ${
                      editScheduleMode === 'now'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Immediate
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditScheduleMode('later')}
                    className={`py-1.5 rounded border font-medium ${
                      editScheduleMode === 'later'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Scheduled Time
                  </button>
                </div>
                {editScheduleMode === 'later' && (
                  <input
                    type="datetime-local"
                    value={editScheduleIso}
                    onChange={(e) => setEditScheduleIso(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 font-mono text-slate-100 outline-none"
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingJob(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSavingEdit}
                className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
              >
                {isSavingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {landingJob && (
        <ShareLandingModal
          target={{
            jobId: landingJob.job_id,
            clipId: landingJob.clip_id,
            clipTitle: landingJob.clip_title,
            videoPath: landingJob.video_path,
            platform: landingJob.platform,
            captionText: landingJob.caption_text,
            tags: landingJob.tags,
            scheduledAtIso: landingJob.scheduled_at_iso,
            status: landingJob.status,
            publishedUrl: landingJob.published_url,
          }}
          channels={channels}
          onUpdateJob={onUpdateJob}
          onDispatchJob={onDispatchJob}
          onClose={() => setLandingJobId(null)}
        />
      )}
    </div>
  );
};
