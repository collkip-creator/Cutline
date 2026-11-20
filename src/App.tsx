import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  Cpu,
  FileText,
  FolderGit2,
  Link2,
  Menu,
  Scissors,
  Sparkles,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { ArchitectureView } from './components/ArchitectureView';
import { ClipInspectorTable } from './components/ClipInspectorTable';
import { ClipPlayerAndTimeline } from './components/ClipPlayerAndTimeline';
import { HardwareTradeoffsView } from './components/HardwareTradeoffsView';
import { PublishQueueView } from './components/PublishQueueView';
import type {
  AspectRatio,
  ClipCandidate,
  EncodeMode,
  ExportResult,
  ProjectRecord,
  PublishJob,
  PublishPlatform,
  Transcript,
} from './types';

type WorkspaceTab = 'studio' | 'queue' | 'architecture' | 'hardware';

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('studio');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Projects & active media state
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean>(false);
  const [clips, setClips] = useState<ClipCandidate[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  // Ingestion & prompt controls
  const [streamUrl, setStreamUrl] = useState('');
  const [prompt, setPrompt] = useState(
    'High-retention hooks, strong architectural claims, and concise 10-30s takeaways'
  );
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('qwen2.5:14b');
  const [whisperModel, setWhisperModel] = useState('faster-whisper-small-int8');

  // Render options
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [encodeMode, setEncodeMode] = useState<EncodeMode>('reencode');
  const [includeSrt, setIncludeSrt] = useState(true);
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);

  // Async states & notices
  const [isIngesting, setIsIngesting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Transcript drawer
  const [showTranscriptDrawer, setShowTranscriptDrawer] = useState(false);
  const [srtImportText, setSrtImportText] = useState('');

  // Queue state & modal
  const [queueJobs, setQueueJobs] = useState<PublishJob[]>([]);
  const [queueModalClip, setQueueModalClip] = useState<ClipCandidate | null>(null);
  const [queuePlatform, setQueuePlatform] = useState<PublishPlatform>('youtube_shorts');
  const [queueCaption, setQueueCaption] = useState('');
  const [queueScheduleMode, setQueueScheduleMode] = useState<'now' | 'later'>('now');
  const [queueScheduleIso, setQueueScheduleIso] = useState(() => {
    const dt = new Date(Date.now() + 3600_000);
    return dt.toISOString().slice(0, 16);
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadProjects = async (selectFirst = false) => {
    const res = await fetch('/api/projects');
    if (!res.ok) return;
    const list: ProjectRecord[] = await res.json();
    setProjects(list);
    if (selectFirst && list.length > 0) {
      await selectProject(list[0].video_hash);
    } else if (selectFirst && list.length === 0) {
      await handleLoadSample();
    }
  };

  const selectProject = async (hash: string) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(hash)}`);
    if (!res.ok) return;
    const data = await res.json();
    setActiveProject(data.project);
    setTranscript(data.transcript);
    setCacheHit(Boolean(data.cache_hit));
    const projectClips: ClipCandidate[] = data.project.clips || [];
    setClips(projectClips);
    setActiveClipId(projectClips[0]?.id || null);
    setLastExport(null);
  };

  const loadQueue = async () => {
    const res = await fetch('/api/queue');
    if (res.ok) {
      setQueueJobs(await res.json());
    }
  };

  useEffect(() => {
    loadProjects(true);
    loadQueue();
  }, []);

  const persistClips = async (hash: string, updatedClips: ClipCandidate[]) => {
    await fetch(`/api/projects/${encodeURIComponent(hash)}/clips`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: updatedClips }),
    });
  };

  const handleLoadSample = async () => {
    setIsIngesting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/projects/sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to synthesize sample');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setLastExport(null);
      await loadProjects(false);
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsIngesting(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setIsIngesting(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await fetch('/api/projects/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Video upload failed');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setLastExport(null);
      await loadProjects(false);
      if (!data.transcript) {
        await handleTranscribe(data.project.video_hash, false);
      }
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsIngesting(false);
    }
  };

  const handleUrlIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!streamUrl.trim()) return;
    setIsIngesting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/projects/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: streamUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'URL ingestion failed');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setStreamUrl('');
      await loadProjects(false);
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsIngesting(false);
    }
  };

  const handleTranscribe = async (hash: string, force = false) => {
    setIsTranscribing(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(hash)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      await loadProjects(false);
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleImportSrt = async () => {
    if (!activeProject || !srtImportText.trim()) return;
    const res = await fetch(
      `/api/projects/${encodeURIComponent(activeProject.video_hash)}/transcript`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srt: srtImportText }),
      }
    );
    const data = await res.json();
    if (res.ok) {
      setTranscript(data.transcript);
      setCacheHit(true);
      setSrtImportText('');
      setNotice({ kind: 'info', text: 'Imported SRT into SHA-256 transcript cache.' });
    } else {
      setNotice({ kind: 'error', text: data.error || 'Failed to parse SRT' });
    }
  };

  const handleExtractHighlights = async () => {
    if (!activeProject) return;
    setIsExtracting(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(activeProject.video_hash)}/highlights`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            ollama_url: ollamaUrl,
            ollama_model: ollamaModel,
            min_clip_sec: Math.min(8, Math.max(3, activeProject.duration_sec * 0.15)),
            max_clip_sec: 45,
            max_clips: 6,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Highlight extraction failed');
      setClips(data.clips);
      setActiveClipId(data.clips[0]?.id || null);
      setNotice({
        kind: 'info',
        text: `Extracted ${data.clips.length} word-grounded clips from cached transcript.`,
      });
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsExtracting(false);
    }
  };

  const handleSnapToWords = async (clip: ClipCandidate) => {
    if (!transcript || !activeProject) return;
    const res = await fetch('/api/clips/snap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip, transcript }),
    });
    if (!res.ok) return;
    const snapped: ClipCandidate = await res.json();
    const next = clips.map((c) => (c.id === clip.id ? snapped : c));
    setClips(next);
    await persistClips(activeProject.video_hash, next);
  };

  const handleChangeClip = (updated: ClipCandidate) => {
    const next = clips.map((c) => (c.id === updated.id ? updated : c));
    setClips(next);
    if (activeProject) {
      persistClips(activeProject.video_hash, next);
    }
  };

  const handleUpdateClipBounds = (clipId: string, startSec: number, endSec: number) => {
    const next = clips.map((c) =>
      c.id === clipId
        ? {
            ...c,
            start_sec: Math.round(startSec * 100) / 100,
            end_sec: Math.round(endSec * 100) / 100,
            snapped_to_words: false,
          }
        : c
    );
    setClips(next);
    if (activeProject) {
      persistClips(activeProject.video_hash, next);
    }
  };

  const handleDeleteClip = (clipId: string) => {
    const next = clips.filter((c) => c.id !== clipId);
    setClips(next);
    if (activeClipId === clipId) {
      setActiveClipId(next[0]?.id || null);
    }
    if (activeProject) {
      persistClips(activeProject.video_hash, next);
    }
  };

  const handleAddManualClip = () => {
    if (!activeProject) return;
    const start = 0;
    const end = Math.min(activeProject.duration_sec, 12);
    const id = `clip_${String(clips.length + 1).padStart(2, '0')}`;
    const created: ClipCandidate = {
      id,
      title: `Manual Clip ${clips.length + 1}`,
      start_sec: start,
      end_sec: end,
      hook_score: 75,
      reason: 'Manually defined range',
      caption_hook: 'KEY TAKEAWAY',
      tags: ['manual'],
    };
    const next = [...clips, created];
    setClips(next);
    setActiveClipId(id);
    persistClips(activeProject.video_hash, next);
  };

  const activeClip = clips.find((c) => c.id === activeClipId) || clips[0] || null;

  const handleExportActiveClip = async () => {
    if (!activeProject || !activeClip) return;
    setIsExporting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/clips/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_hash: activeProject.video_hash,
          clip: activeClip,
          aspect_ratio: aspectRatio,
          encode_mode: encodeMode,
          include_srt: includeSrt,
          burn_captions: burnCaptions,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FFmpeg export failed');
      setLastExport(data);
      setNotice({
        kind: 'info',
        text: `Exported ${activeClip.id} (${data.aspect_ratio}, ${(data.file_size_bytes / 1024).toFixed(0)} KB).`,
      });
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsExporting(false);
    }
  };

  const openQueueModal = (clip: ClipCandidate) => {
    setQueueModalClip(clip);
    setQueueCaption(clip.caption_hook ? `${clip.caption_hook} — ${clip.title}` : clip.title);
  };

  const submitQueueJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queueModalClip || !activeProject) return;

    let exportPath = lastExport?.clip_id === queueModalClip.id ? lastExport.video_path : '';
    let srtPath = lastExport?.clip_id === queueModalClip.id ? lastExport.srt_path : null;

    // Ensure the actual MP4 exists on disk before queuing so SocialPublisher verification passes
    if (!exportPath) {
      setIsExporting(true);
      const expRes = await fetch('/api/clips/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_hash: activeProject.video_hash,
          clip: queueModalClip,
          aspect_ratio: aspectRatio,
          encode_mode: encodeMode,
          include_srt: true,
          burn_captions: burnCaptions,
        }),
      });
      setIsExporting(false);
      if (expRes.ok) {
        const expData = await expRes.json();
        exportPath = expData.video_path;
        srtPath = expData.srt_path;
        setLastExport(expData);
      }
    }

    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clip_id: queueModalClip.id,
        clip_title: queueModalClip.title,
        video_path: exportPath || activeProject.local_path,
        srt_path: srtPath,
        platform: queuePlatform,
        caption_text: queueCaption,
        tags: queueModalClip.tags,
        scheduled_at_iso:
          queueScheduleMode === 'later' ? new Date(queueScheduleIso).toISOString() : null,
      }),
    });

    if (res.ok) {
      setQueueModalClip(null);
      await loadQueue();
      setActiveTab('queue');
    }
  };

  const navItems: Array<{ id: WorkspaceTab; label: string; icon: React.ReactNode }> = [
    { id: 'studio', label: 'Clip Studio', icon: <Scissors className="w-4 h-4" /> },
    { id: 'queue', label: 'Publish Queue', icon: <CalendarClock className="w-4 h-4" /> },
    { id: 'architecture', label: 'Architecture & Code', icon: <FolderGit2 className="w-4 h-4" /> },
    { id: 'hardware', label: 'Mobile & Hardware', icon: <Cpu className="w-4 h-4" /> },
  ];

  const breadcrumbTitle: Record<WorkspaceTab, string> = {
    studio: 'Clip Studio',
    queue: 'Publish Queue',
    architecture: 'Architecture & Code',
    hardware: 'Mobile & Hardware Trade-offs',
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[264px] bg-[#0F1522] border-r border-slate-800/90 flex flex-col transition-transform duration-150 lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-14 px-4 border-b border-slate-800/80 flex items-center justify-between">
          <span className="font-display font-bold text-base tracking-tight text-white whitespace-nowrap">
            Cutline Studio
          </span>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden p-1 text-slate-400 hover:text-white"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="p-3 space-y-1 border-b border-slate-800/80">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileNavOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-600/15 text-blue-300 border border-blue-500/30'
                    : 'text-slate-300 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <span className="inline-flex items-center gap-2.5">
                  {item.icon}
                  {item.label}
                </span>
                {item.id === 'queue' && queueJobs.length > 0 && (
                  <span className="font-mono tabular-nums text-[11px] text-slate-400">
                    {queueJobs.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Cached Media Library */}
        <div className="p-3 flex-1 overflow-y-auto space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold text-slate-400">Project Library</span>
            <span className="text-[11px] font-mono tabular-nums text-slate-500">
              {projects.length}
            </span>
          </div>
          <div className="space-y-1">
            {projects.map((p) => {
              const selected = activeProject?.video_hash === p.video_hash;
              return (
                <button
                  key={p.video_hash}
                  type="button"
                  onClick={() => {
                    selectProject(p.video_hash);
                    setActiveTab('studio');
                    setMobileNavOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-2 rounded border transition-colors ${
                    selected
                      ? 'bg-slate-800/70 border-slate-700 text-white'
                      : 'bg-transparent border-transparent hover:bg-slate-800/35 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Video className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs font-medium truncate">{p.title}</span>
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1 pl-5">
                    {p.duration_sec.toFixed(1)}s · {p.transcript_cached ? 'Cached' : 'Uncached'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Local Adapter Endpoints */}
        <div className="p-3 border-t border-slate-800/80 space-y-2.5 bg-[#0C111C]">
          <div className="text-[11px] font-semibold text-slate-400">Local Engine Config</div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Ollama Base URL</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              className="w-full bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 outline-none focus:border-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">LLM Model</label>
              <input
                type="text"
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">ASR Model</label>
              <input
                type="text"
                value={whisperModel}
                onChange={(e) => setWhisperModel(e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on left, max 1 primary CTA on right */}
        <header className="h-14 px-4 lg:px-6 border-b border-slate-800/90 bg-[#0F1522]/80 backdrop-blur flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 text-slate-300 hover:text-white bg-slate-800/60 rounded"
              aria-label="Open menu"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-400 truncate">
              <span className="text-slate-200 font-medium">Cutline Studio</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{breadcrumbTitle[activeTab]}</span>
              {activeTab === 'studio' && activeProject && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">/</span>
                  <span className="hidden sm:inline text-slate-300 truncate max-w-[260px]">
                    {activeProject.title}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="shrink-0">
            {activeTab === 'studio' ? (
              <button
                type="button"
                disabled={!activeClip || isExporting}
                onClick={handleExportActiveClip}
                className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap shrink-0"
              >
                {isExporting ? 'Exporting...' : 'Export Active Clip'}
              </button>
            ) : (
              <a
                href="/api/architecture/bundle"
                download="clippah_core_starter.zip"
                className="inline-block px-4 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
              >
                Download Python Core
              </a>
            )}
          </div>
        </header>

        <main className="p-4 lg:p-6 max-w-[1440px] w-full mx-auto space-y-5 flex-1">
          {notice && (
            <div
              className={`px-4 py-2.5 rounded-md border text-xs flex items-center justify-between gap-4 ${
                notice.kind === 'error'
                  ? 'bg-rose-950/35 border-rose-500/40 text-rose-200'
                  : 'bg-emerald-950/35 border-emerald-500/40 text-emerald-200'
              }`}
            >
              <span>{notice.text}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="text-slate-400 hover:text-white shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'studio' && (
            <div className="space-y-5">
              {/* Media Ingest & Highlight Prompt Bar */}
              <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
                  <div className="lg:col-span-5 flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileUpload(f);
                      }}
                    />
                    <button
                      type="button"
                      disabled={isIngesting}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Pick Local Video
                    </button>
                    <button
                      type="button"
                      disabled={isIngesting}
                      onClick={handleLoadSample}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Video className="w-3.5 h-3.5" />
                      {isIngesting ? 'Preparing...' : 'Load Sample Footage'}
                    </button>
                  </div>

                  <form onSubmit={handleUrlIngest} className="lg:col-span-7 flex items-center gap-2">
                    <div className="relative flex-1 min-w-0">
                      <Link2 className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="url"
                        value={streamUrl}
                        onChange={(e) => setStreamUrl(e.target.value)}
                        placeholder="Streaming URL for yt-dlp ingestion (https://...)"
                        className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded pl-8 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isIngesting || !streamUrl.trim()}
                      className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      Fetch URL
                    </button>
                  </form>
                </div>

                {/* Highlight Extraction & Transcript Cache Row */}
                {activeProject && (
                  <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2.5">
                    <input
                      type="text"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe the moments or hooks to extract..."
                      className="flex-1 min-w-[260px] bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded px-3 py-2 text-xs text-slate-100 outline-none"
                    />
                    <button
                      type="button"
                      disabled={isTranscribing}
                      onClick={() => handleTranscribe(activeProject.video_hash, true)}
                      className="px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {isTranscribing ? 'Transcribing...' : 'Re-Transcribe'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowTranscriptDrawer((v) => !v)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Transcript ({transcript?.segments.length ?? 0} segs)
                    </button>
                    <button
                      type="button"
                      disabled={isExtracting || !transcript}
                      onClick={handleExtractHighlights}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {isExtracting ? 'Extracting...' : 'Extract Clips'}
                    </button>
                    <span className="text-[11px] font-mono tabular-nums text-slate-400 ml-auto">
                      {cacheHit ? 'Transcript cached · 0ms ASR' : 'Uncached'} · SHA256{' '}
                      {activeProject.video_hash.slice(0, 8)}
                    </span>
                  </div>
                )}

                {/* Collapsible Cached Transcript & SRT Import Drawer */}
                {showTranscriptDrawer && activeProject && (
                  <div className="pt-3 border-t border-slate-800/80 grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="text-xs font-semibold text-slate-200">
                        Cached Word-Timestamped Segments
                      </div>
                      <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 max-h-52 overflow-y-auto space-y-2 text-xs">
                        {transcript?.segments.map((seg) => (
                          <div key={seg.id} className="leading-relaxed">
                            <span className="font-mono tabular-nums text-blue-400 mr-2">
                              [{seg.start_sec.toFixed(2)}–{seg.end_sec.toFixed(2)}]
                            </span>
                            <span className="text-slate-200">{seg.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-200">
                          Replace / Import Custom SRT Transcript
                        </span>
                        <button
                          type="button"
                          onClick={handleImportSrt}
                          disabled={!srtImportText.trim()}
                          className="px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded"
                        >
                          Save SRT to Cache
                        </button>
                      </div>
                      <textarea
                        value={srtImportText}
                        onChange={(e) => setSrtImportText(e.target.value)}
                        placeholder={`1\n00:00:00,500 --> 00:00:05,200\nPaste .srt content to test grounding on your own uploaded clip...`}
                        className="w-full h-44 bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded p-2.5 text-[11px] font-mono text-slate-200 outline-none resize-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              {activeProject ? (
                <>
                  <ClipPlayerAndTimeline
                    project={activeProject}
                    transcript={transcript}
                    clips={clips}
                    activeClip={activeClip}
                    aspectRatio={aspectRatio}
                    onAspectRatioChange={setAspectRatio}
                    encodeMode={encodeMode}
                    onEncodeModeChange={setEncodeMode}
                    includeSrt={includeSrt}
                    onIncludeSrtChange={setIncludeSrt}
                    burnCaptions={burnCaptions}
                    onBurnCaptionsChange={setBurnCaptions}
                    onSelectClip={(c) => setActiveClipId(c.id)}
                    onUpdateClipBounds={handleUpdateClipBounds}
                    onExportClip={handleExportActiveClip}
                    isExporting={isExporting}
                    lastExport={lastExport}
                    onOpenQueueModal={openQueueModal}
                  />

                  <ClipInspectorTable
                    clips={clips}
                    activeClipId={activeClipId}
                    transcript={transcript}
                    aspectRatio={aspectRatio}
                    onSelectClip={(c) => setActiveClipId(c.id)}
                    onChangeClip={handleChangeClip}
                    onDeleteClip={handleDeleteClip}
                    onAddManualClip={handleAddManualClip}
                    onSnapToWords={handleSnapToWords}
                    onQueueClip={openQueueModal}
                  />
                </>
              ) : (
                <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-12 text-center space-y-3">
                  <p className="text-sm font-semibold text-slate-200">
                    Preparing local media workspace...
                  </p>
                  <button
                    type="button"
                    onClick={handleLoadSample}
                    className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded"
                  >
                    Load Sample Footage
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'queue' && (
            <PublishQueueView
              jobs={queueJobs}
              onRefresh={loadQueue}
              onProcessDue={async (includeFuture) => {
                await fetch('/api/queue/process', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ include_future: includeFuture }),
                });
                await loadQueue();
              }}
              onRetryJob={async (jobId) => {
                await fetch(`/api/queue/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
                await loadQueue();
              }}
              onDeleteJob={async (jobId) => {
                await fetch(`/api/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
                await loadQueue();
              }}
            />
          )}

          {activeTab === 'architecture' && <ArchitectureView />}

          {activeTab === 'hardware' && <HardwareTradeoffsView />}
        </main>
      </div>

      {/* Enqueue Social Publish Modal */}
      {queueModalClip && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={submitQueueJob}
            className="w-full max-w-md bg-[#111724] border border-slate-700 rounded-lg p-5 space-y-4"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100">
                Queue Clip for Social Publishing
              </h3>
              <button
                type="button"
                onClick={() => setQueueModalClip(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Clip</label>
                <div className="font-medium text-slate-100">
                  {queueModalClip.id} · {queueModalClip.title}
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Target Platform Adapter</label>
                <select
                  value={queuePlatform}
                  onChange={(e) => setQueuePlatform(e.target.value as PublishPlatform)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                >
                  <option value="youtube_shorts">YouTube Shorts</option>
                  <option value="tiktok">TikTok</option>
                  <option value="instagram_reels">Instagram Reels</option>
                  <option value="x_video">X Video</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Post Caption</label>
                <textarea
                  rows={3}
                  value={queueCaption}
                  onChange={(e) => setQueueCaption(e.target.value)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 text-slate-100 outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Dispatch Schedule</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setQueueScheduleMode('now')}
                    className={`py-1.5 rounded border font-medium ${
                      queueScheduleMode === 'now'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Queue Immediately
                  </button>
                  <button
                    type="button"
                    onClick={() => setQueueScheduleMode('later')}
                    className={`py-1.5 rounded border font-medium ${
                      queueScheduleMode === 'later'
                        ? 'bg-blue-600/20 border-blue-500 text-white'
                        : 'bg-[#0B0F17] border-slate-800 text-slate-400'
                    }`}
                  >
                    Schedule Date/Time
                  </button>
                </div>
                {queueScheduleMode === 'later' && (
                  <input
                    type="datetime-local"
                    value={queueScheduleIso}
                    onChange={(e) => setQueueScheduleIso(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 font-mono text-slate-100 outline-none"
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setQueueModalClip(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isExporting}
                className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
              >
                {isExporting ? 'Rendering & Queuing...' : 'Add to SQLite Queue'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
