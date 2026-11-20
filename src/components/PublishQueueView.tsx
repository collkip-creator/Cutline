import React, { useState } from 'react';
import { CalendarClock, PlayCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { PublishJob, PublishPlatform, PublishStatus } from '../types';

interface PublishQueueViewProps {
  jobs: PublishJob[];
  onRefresh: () => Promise<void>;
  onProcessDue: (includeFuture: boolean) => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onDeleteJob: (jobId: string) => Promise<void>;
}

const PLATFORM_LABELS: Record<PublishPlatform, string> = {
  youtube_shorts: 'YouTube Shorts',
  tiktok: 'TikTok',
  instagram_reels: 'Instagram Reels',
  x_video: 'X Video',
};

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
  onRefresh,
  onProcessDue,
  onRetryJob,
  onDeleteJob,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | PublishStatus>('all');
  const [isProcessing, setIsProcessing] = useState(false);

  const filtered = statusFilter === 'all' ? jobs : jobs.filter((j) => j.status === statusFilter);

  const counts = {
    all: jobs.length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    scheduled: jobs.filter((j) => j.status === 'scheduled').length,
    published: jobs.filter((j) => j.status === 'published').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
  };

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Local SQLite Publish & Schedule Queue
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Persisted in <code className="text-slate-300">data/clippah_queue.db</code> via{' '}
            <code className="text-slate-300">PublishQueueStore</code>. Dispatches through pluggable{' '}
            <code className="text-slate-300">SocialPublisher</code> adapters.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
              Export a clip in Clip Studio and click Queue Post to enqueue immediate or scheduled social publishing jobs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0D121D] text-[11px] font-medium text-slate-400">
                  <th className="py-2.5 px-3">Job ID</th>
                  <th className="py-2.5 px-3">Clip & Caption</th>
                  <th className="py-2.5 px-3">Platform</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Schedule / Receipt</th>
                  <th className="py-2.5 px-3 text-right">Attempts</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {filtered.map((job) => {
                  const st = STATUS_DISPLAY[job.status];
                  return (
                    <tr key={job.job_id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-3 font-mono tabular-nums text-slate-300 align-top">
                        {job.job_id}
                      </td>
                      <td className="py-3 px-3 align-top max-w-xs">
                        <div className="font-medium text-slate-100 truncate">{job.clip_title}</div>
                        <div className="text-slate-400 truncate mt-0.5">{job.caption_text}</div>
                        {job.tags.length > 0 && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {job.tags.map((t) => `#${t}`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-200 align-top whitespace-nowrap">
                        {PLATFORM_LABELS[job.platform] || job.platform}
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
                          <div className="text-emerald-400 truncate max-w-[240px] mt-0.5">
                            {job.published_url}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300 align-top">
                        {job.attempts}
                      </td>
                      <td className="py-3 px-3 text-right align-top">
                        <div className="inline-flex items-center gap-1.5">
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
    </div>
  );
};
