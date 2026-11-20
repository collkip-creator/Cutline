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
import { SharePublishModal } from './components/SharePublishModal';
import {
  apiFetch,
  apiUrl,
  checkSidecarHealth,
  getTauriSidecarDiagnostics,
  isTauriRuntime,
  readJsonResponse,
  restartTauriSidecar,
  type SidecarDiagnostics,
} from './lib/api';
import { downloadUrlViaBlob } from './lib/localExports';
import type {
  AspectRatio,
  ClipCandidate,
  EncodeMode,
  ExportResult,
  ProjectRecord,
  PublishChannelConfig,
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
    'Strongest standalone moments across actionable lessons, entertaining banter/stories, and high-retention hooks'
  );
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('qwen2.5:14b');
  const [whisperModel, setWhisperModel] = useState('faster-whisper-small-int8');
  const [isDownloadingBundle, setIsDownloadingBundle] = useState(false);

  // Render options
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [encodeMode, setEncodeMode] = useState<EncodeMode>('reencode');
  const [includeSrt, setIncludeSrt] = useState(true);
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);

  // Async states & notices
  const [sidecarStatus, setSidecarStatus] = useState<'checking' | 'ready' | 'starting' | 'error'>(
    isTauriRuntime ? 'starting' : 'checking'
  );
  const [sidecarDiag, setSidecarDiag] = useState<SidecarDiagnostics | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Transcript drawer
  const [showTranscriptDrawer, setShowTranscriptDrawer] = useState(false);
  const [srtImportText, setSrtImportText] = useState('');

  // Queue state & modal
  const [queueJobs, setQueueJobs] = useState<PublishJob[]>([]);
  const [queueChannels, setQueueChannels] = useState<PublishChannelConfig[]>([]);
  const [queueModalClip, setQueueModalClip] = useState<ClipCandidate | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadProjects = async (selectFirst = false) => {
    try {
      const res = await apiFetch('/api/projects');
      const list = await readJsonResponse<ProjectRecord[]>(res);
      setProjects(list);
      if (selectFirst && list.length > 0) {
        await selectProject(list[0].video_hash);
      } else if (selectFirst && list.length === 0) {
        await handleLoadSample();
      }
    } catch {
      // Ignore transient cold-start poll errors
    }
  };

  const selectProject = async (hash: string) => {
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(hash)}`);
      const data = await readJsonResponse<{
        project: ProjectRecord;
        transcript: Transcript | null;
        cache_hit: boolean;
      }>(res);
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      const projectClips: ClipCandidate[] = data.project.clips || [];
      setClips(projectClips);
      setActiveClipId(projectClips[0]?.id || null);
      setLastExport(null);
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    }
  };

  const loadQueue = async () => {
    try {
      const [jobsRes, chRes] = await Promise.all([
        apiFetch('/api/queue'),
        apiFetch('/api/queue/channels'),
      ]);
      setQueueJobs(await readJsonResponse<PublishJob[]>(jobsRes));
      setQueueChannels(await readJsonResponse<PublishChannelConfig[]>(chRes));
    } catch {
      // Ignore transient cold-start poll errors
    }
  };

  const bootWorkspace = async () => {
    let cancelled = false;
    const maxPolls = isTauriRuntime ? 50 : 2;
    if (isTauriRuntime) {
      setSidecarStatus('starting');
    }

    for (let i = 0; i < maxPolls; i++) {
      if (cancelled) return;
      const healthy = await checkSidecarHealth(2000);
      if (healthy) {
        setSidecarStatus('ready');
        setSidecarDiag(null);
        await Promise.all([loadProjects(true), loadQueue()]);
        return;
      }
      if (isTauriRuntime) {
        const diag = await getTauriSidecarDiagnostics();
        if (diag) {
          setSidecarDiag(diag);
          if (diag.spawn_error || diag.terminated) {
            setSidecarStatus('error');
            return;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 750));
    }

    if (isTauriRuntime) {
      setSidecarDiag(await getTauriSidecarDiagnostics());
      setSidecarStatus('error');
    } else {
      setSidecarStatus('ready');
      await Promise.all([loadProjects(true), loadQueue()]);
    }
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    bootWorkspace();
  }, []);

  const handleRestartSidecar = async () => {
    setSidecarStatus('starting');
    setSidecarDiag(null);
    setNotice(null);
    await restartTauriSidecar();
    await bootWorkspace();
  };

  const persistClips = async (hash: string, updatedClips: ClipCandidate[]) => {
    await apiFetch(`/api/projects/${encodeURIComponent(hash)}/clips`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: updatedClips }),
    });
  };

  const handleLoadSample = async () => {
    setIsLoadingSample(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/projects/sample', { method: 'POST' });
      const data = await readJsonResponse<any>(res);
      setSidecarStatus('ready');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setLastExport(null);
      await loadProjects(false);
    } catch (err: any) {
      if (isTauriRuntime) setSidecarDiag(await getTauriSidecarDiagnostics());
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsLoadingSample(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    setIsUploading(true);
    setNotice({
      kind: 'info',
      text: `Loading "${file.name}" (${sizeMb} MB) into local workspace...`,
    });
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await apiFetch('/api/projects/upload', { method: 'POST', body: form });
      const data = await readJsonResponse<any>(res);
      setSidecarStatus('ready');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setLastExport(null);
      await loadProjects(false);
      if (!data.transcript) {
        await handleTranscribe(data.project.video_hash, false);
      } else {
        setNotice({ kind: 'info', text: `Loaded "${file.name}" with cached transcript.` });
      }
    } catch (err: any) {
      if (isTauriRuntime) setSidecarDiag(await getTauriSidecarDiagnostics());
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsUploading(false);
    }
  };

  const handleUrlIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!streamUrl.trim()) return;
    setIsFetchingUrl(true);
    setNotice({
      kind: 'info',
      text: 'Fetching stream via yt-dlp (this can take 10–60s depending on stream size)...',
    });
    try {
      const res = await apiFetch('/api/projects/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: streamUrl.trim() }),
      });
      const data = await readJsonResponse<any>(res);
      setSidecarStatus('ready');
      setActiveProject(data.project);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      setClips(data.project.clips || []);
      setActiveClipId(data.project.clips?.[0]?.id || null);
      setStreamUrl('');
      setNotice({ kind: 'info', text: `Imported "${data.project.title}" from URL.` });
      await loadProjects(false);
    } catch (err: any) {
      if (isTauriRuntime) setSidecarDiag(await getTauriSidecarDiagnostics());
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const handleTranscribe = async (hash: string, force = false): Promise<Transcript | null> => {
    setIsTranscribing(true);
    setNotice(null);
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(hash)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await readJsonResponse<{
        transcript: Transcript;
        cache_hit: boolean;
        warning?: string;
      }>(res);
      setTranscript(data.transcript);
      setCacheHit(Boolean(data.cache_hit));
      if (data.warning) {
        setNotice({ kind: 'info', text: data.warning });
      }
      await loadProjects(false);
      return data.transcript;
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
      return null;
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleImportSrt = async () => {
    if (!activeProject || !srtImportText.trim()) return;
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(activeProject.video_hash)}/transcript`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ srt: srtImportText }),
        }
      );
      const data = await readJsonResponse<any>(res);
      setTranscript(data.transcript);
      setCacheHit(true);
      setSrtImportText('');
      setNotice({ kind: 'info', text: 'Imported SRT into SHA-256 transcript cache.' });
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message || 'Failed to parse SRT' });
    }
  };

  const handleExtractHighlights = async () => {
    if (!activeProject) return;
    setIsExtracting(true);
    setNotice(null);
    try {
      let currentTranscript = transcript;
      if (!currentTranscript) {
        currentTranscript = await handleTranscribe(activeProject.video_hash, false);
        if (!currentTranscript) {
          throw new Error('Could not obtain transcript before extracting clips.');
        }
      }
      const res = await apiFetch(
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
      const data = await readJsonResponse<{ clips: ClipCandidate[] }>(res);
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
    const res = await apiFetch('/api/clips/snap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip, transcript }),
    });
    const snapped = await readJsonResponse<ClipCandidate>(res);
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

  const handleAddManualClip = (startSec?: number, endSec?: number) => {
    if (!activeProject) return;
    const maxDur = Math.max(1, activeProject.duration_sec || 10);
    const defaultStart =
      clips.length > 0
        ? Math.min(Math.max(0, maxDur - 2), Math.max(...clips.map((c) => c.end_sec)))
        : 0;
    const rawStart = startSec ?? defaultStart;
    const rawEnd = endSec ?? Math.min(maxDur, rawStart + 12);
    const start = Math.round(Math.max(0, Math.min(rawStart, rawEnd)) * 100) / 100;
    const end =
      Math.round(
        Math.min(maxDur, Math.max(start + Math.min(1.0, maxDur - start), Math.max(rawStart, rawEnd))) *
          100
      ) / 100;

    let maxIdx = 0;
    for (const c of clips) {
      const m = c.id.match(/(\d+)$/);
      if (m) maxIdx = Math.max(maxIdx, Number(m[1]));
    }
    const nextNum = Math.max(clips.length + 1, maxIdx + 1);
    const id = `clip_${String(nextNum).padStart(2, '0')}`;

    const spokenText = transcript
      ? transcript.segments
          .filter((s) => s.end_sec >= start && s.start_sec <= end)
          .map((s) => s.text.trim())
          .join(' ')
          .trim()
      : '';
    const autoTitle = spokenText
      ? spokenText.slice(0, 56) + (spokenText.length > 56 ? '…' : '')
      : `Manual Clip ${nextNum}`;
    const autoHook = spokenText
      ? spokenText.split(/[.!?]/)[0].trim().slice(0, 44).toUpperCase() || 'HIGHLIGHT'
      : 'KEY TAKEAWAY';

    const created: ClipCandidate = {
      id,
      title: autoTitle,
      category: 'insight',
      start_sec: start,
      end_sec: end,
      hook_score: 7.5,
      lesson_score: 7.0,
      entertainment_score: 6.5,
      reason: 'Manually marked start/end range',
      caption_hook: autoHook,
      tags: ['manual'],
    };
    const next = [...clips, created].sort((a, b) => a.start_sec - b.start_sec);
    setClips(next);
    setActiveClipId(id);
    setNotice({
      kind: 'info',
      text: `Added ${id} (${start.toFixed(2)}s – ${end.toFixed(2)}s · ${(end - start).toFixed(2)}s).`,
    });
    persistClips(activeProject.video_hash, next);
  };

  const activeClip = clips.find((c) => c.id === activeClipId) || clips[0] || null;

  const handleExportActiveClip = async () => {
    if (!activeProject || !activeClip) return;
    setIsExporting(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/clips/export', {
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
      const data = await readJsonResponse<ExportResult>(res);
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
              <button
                type="button"
                disabled={isDownloadingBundle}
                onClick={async () => {
                  setIsDownloadingBundle(true);
                  try {
                    await downloadUrlViaBlob(
                      apiUrl('/api/architecture/bundle'),
                      'cutline_studio_tauri_starter.zip'
                    );
                  } catch (err: any) {
                    setNotice({ kind: 'error', text: err?.message || 'Bundle download failed.' });
                  } finally {
                    setIsDownloadingBundle(false);
                  }
                }}
                className="inline-block px-4 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
              >
                {isDownloadingBundle ? 'Downloading Bundle...' : 'Download Tauri + Python Bundle'}
              </button>
            )}
          </div>
        </header>

        <main className="p-4 lg:p-6 max-w-[1440px] w-full mx-auto space-y-5 flex-1">
          {isTauriRuntime && sidecarStatus !== 'ready' && (
            <div
              className={`px-4 py-3 rounded-md border text-xs space-y-2 ${
                sidecarStatus === 'error'
                  ? 'bg-rose-950/40 border-rose-500/40 text-rose-100'
                  : 'bg-amber-950/35 border-amber-500/40 text-amber-100'
              }`}
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="font-medium">
                  {sidecarStatus === 'starting'
                    ? 'Starting local Python sidecar on 127.0.0.1:43111 (first launch unpacks Whisper & FFmpeg runtime)...'
                    : `Local Python sidecar failed to start (${sidecarDiag?.terminated || sidecarDiag?.spawn_error || '127.0.0.1:43111 unreachable'}).`}
                </span>
                <button
                  type="button"
                  onClick={handleRestartSidecar}
                  className="px-3 py-1 text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-700 text-white rounded shrink-0"
                >
                  Restart Sidecar
                </button>
              </div>
              {sidecarStatus === 'error' && (sidecarDiag?.log_file_tail || sidecarDiag?.logs.length) ? (
                <pre className="bg-[#0B0F17] border border-slate-800 rounded p-2.5 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-36">
                  {sidecarDiag.log_file_tail || sidecarDiag.logs.join('\n')}
                </pre>
              ) : null}
            </div>
          )}

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
                      accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v"
                      className="sr-only"
                      onClick={(e) => {
                        e.currentTarget.value = '';
                      }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileUpload(f);
                      }}
                    />
                    <button
                      type="button"
                      disabled={isUploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {isUploading ? 'Uploading...' : 'Pick Local Video'}
                    </button>
                    <button
                      type="button"
                      disabled={isLoadingSample}
                      onClick={handleLoadSample}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 disabled:opacity-50 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Video className="w-3.5 h-3.5" />
                      {isLoadingSample ? 'Preparing...' : 'Load Sample Footage'}
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
                      disabled={isFetchingUrl || !streamUrl.trim()}
                      className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {isFetchingUrl ? 'Fetching...' : 'Fetch URL'}
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
                      onClick={() => handleTranscribe(activeProject.video_hash, Boolean(transcript))}
                      className="px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {isTranscribing
                        ? 'Transcribing...'
                        : transcript
                          ? 'Re-Transcribe'
                          : 'Transcribe Video'}
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
                      disabled={isExtracting || isTranscribing}
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
                    onAddClipRange={(s, e) => handleAddManualClip(s, e)}
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
                    onAddManualClip={() => handleAddManualClip()}
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
              channels={queueChannels}
              onRefresh={loadQueue}
              onProcessDue={async (includeFuture) => {
                await apiFetch('/api/queue/process', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ include_future: includeFuture }),
                });
                await loadQueue();
              }}
              onDispatchJob={async (jobId) => {
                await apiFetch(`/api/queue/${encodeURIComponent(jobId)}/dispatch`, {
                  method: 'POST',
                });
                await loadQueue();
              }}
              onUpdateJob={async (jobId, patch) => {
                await apiFetch(`/api/queue/${encodeURIComponent(jobId)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(patch),
                });
                await loadQueue();
              }}
              onRetryJob={async (jobId) => {
                await apiFetch(`/api/queue/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
                await loadQueue();
              }}
              onDeleteJob={async (jobId) => {
                await apiFetch(`/api/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
                await loadQueue();
              }}
              onSaveChannel={async (platform, payload) => {
                const res = await apiFetch(`/api/queue/channels/${encodeURIComponent(platform)}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                });
                await readJsonResponse(res);
                await loadQueue();
              }}
              onTestChannel={async (platform, payload) => {
                const res = await apiFetch(`/api/queue/channels/${encodeURIComponent(platform)}/test`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                });
                return readJsonResponse<{ ok: boolean; status_code: number | null; message: string }>(res);
              }}
            />
          )}

          {activeTab === 'architecture' && <ArchitectureView />}

          {activeTab === 'hardware' && <HardwareTradeoffsView />}
        </main>
      </div>

      {/* Share & Multi-Platform Publish Modal */}
      {queueModalClip && activeProject && (
        <SharePublishModal
          clip={queueModalClip}
          project={activeProject}
          aspectRatio={aspectRatio}
          encodeMode={encodeMode}
          burnCaptions={burnCaptions}
          lastExport={lastExport}
          channels={queueChannels}
          onExportCompleted={(expData) => setLastExport(expData)}
          onQueueCompleted={async (count, dispatchedNow) => {
            await loadQueue();
            setNotice({
              kind: 'info',
              text: dispatchedNow
                ? `Published ${count} channel job${count > 1 ? 's' : ''} through configured adapters.`
                : `Queued ${count} social share job${count > 1 ? 's' : ''}.`,
            });
            setActiveTab('queue');
          }}
          onClose={() => setQueueModalClip(null)}
        />
      )}
    </div>
  );
}
