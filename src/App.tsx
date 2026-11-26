import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  Cpu,
  FileText,
  FolderGit2,
  Link2,
  Loader2,
  Menu,
  Mic,
  Scissors,
  Search,
  Sparkles,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react';
import { ArchitectureView } from './components/ArchitectureView';
import { AudioTranscribeView } from './components/AudioTranscribeView';
import { ClipInspectorTable } from './components/ClipInspectorTable';
import { ClipPlayerAndTimeline } from './components/ClipPlayerAndTimeline';
import { DesktopAuthBridgeScreen } from './components/DesktopAuthBridgeScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
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
  ClipSentiment,
  EncodeMode,
  ExportResult,
  ProjectRecord,
  PublishChannelConfig,
  PublishJob,
  PublishPlatform,
  Transcript,
} from './types';

type WorkspaceTab = 'studio' | 'transcribe' | 'queue' | 'architecture' | 'hardware';

const HASHTAG_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'almost', 'alone', 'along', 'already',
  'also', 'although', 'always', 'among', 'another', 'around', 'because', 'before',
  'being', 'below', 'between', 'both', 'could', 'doing', 'during', 'either',
  'enough', 'every', 'everyone', 'everything', 'first', 'found', 'getting', 'going',
  'gonna', 'great', 'having', 'herself', 'himself', 'however', 'instead', 'into',
  'just', 'knowing', 'later', 'least', 'little', 'looks', 'making', 'maybe',
  'might', 'more', 'most', 'mostly', 'much', 'myself', 'never', 'nothing',
  'often', 'other', 'others', 'outside', 'people', 'perhaps', 'quite', 'rather',
  'really', 'right', 'should', 'since', 'some', 'someone', 'something', 'sometimes',
  'still', 'such', 'taking', 'thank', 'thanks', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'thing', 'things', 'think',
  'thinking', 'this', 'those', 'though', 'three', 'through', 'today', 'together',
  'trying', 'under', 'until', 'using', 'very', 'want', 'wanna', 'water', 'welcome',
  'well', 'were', 'what', 'whatever', 'when', 'where', 'whereas', 'whether',
  'which', 'while', 'whole', 'whose', 'will', 'with', 'within', 'without',
  'would', 'yeah', 'your', 'yours', 'yourself',
]);

const SOCIAL_TOPIC_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\b(ai|llm|model|ollama|whisper|neural|gpt|prompt|transcrib)\b/i, tag: '#AIWorkflow' },
  { pattern: /\b(local|offline|privacy|private|latency|edge|server|upload|gigabyte)\b/i, tag: '#LocalAI' },
  { pattern: /\b(video|clip|edit|editing|ffmpeg|caption|subtitle|render|frame|aspect|vertical)\b/i, tag: '#VideoEditing' },
  { pattern: /\b(creator|youtube|tiktok|instagram|social|audience|viral|retention|hook)\b/i, tag: '#ContentCreator' },
  { pattern: /\b(podcast|interview|mic|audio|voice|speak|speaker)\b/i, tag: '#PodcastClips' },
  { pattern: /\b(code|coding|python|typescript|react|api|software|developer|build|app)\b/i, tag: '#SoftwareDev' },
  { pattern: /\b(productiv|workflow|automat|fast|speed|tip|hack|habit|system)\b/i, tag: '#ProductivityTips' },
  { pattern: /\b(business|startup|founder|growth|client|sales|marketing|brand)\b/i, tag: '#CreatorEconomy' },
  { pattern: /\b(story|funny|laugh|crazy|moment|reaction|banter)\b/i, tag: '#StoryTime' },
  { pattern: /\b(learn|lesson|mistake|secret|truth|advice|guide|tutorial)\b/i, tag: '#LearnOnShorts' },
];

function generateTranscriptHashtags(
  clip: ClipCandidate,
  transcriptData: Transcript | null,
  count = 3
): string[] {
  const existingKeys = new Set(
    (clip.tags || [])
      .map((t) => t.trim().replace(/^#+/, '').toLowerCase())
      .filter(Boolean)
  );

  const segmentText = transcriptData?.segments
    .filter((s) => s.end_sec >= clip.start_sec && s.start_sec <= clip.end_sec)
    .map((s) => s.text)
    .join(' ')
    .trim();

  const contextText = [segmentText, clip.title, clip.caption_hook, clip.reason]
    .filter(Boolean)
    .join(' ');

  const generated: string[] = [];
  const seenKeys = new Set<string>(existingKeys);

  const tryPush = (rawTag: string) => {
    const cleanBody = rawTag.replace(/^#+/, '').replace(/[^a-zA-Z0-9]/g, '');
    if (!cleanBody || cleanBody.length < 3) return false;
    const key = cleanBody.toLowerCase();
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    generated.push(`#${cleanBody}`);
    return true;
  };

  // 1. Score standout spoken keywords from the clip's transcript segment
  const keywordCounts = new Map<string, number>();
  const words = (segmentText || contextText)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !HASHTAG_STOPWORDS.has(w));

  for (const w of words) {
    keywordCounts.set(w, (keywordCounts.get(w) || 0) + 1);
  }

  const rankedKeywords = Array.from(keywordCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));

  // Take up to 2 grounded keywords from the spoken segment first
  for (const kw of rankedKeywords) {
    if (generated.length >= 2) break;
    tryPush(kw);
  }

  // 2. Match high-signal social topic hashtags based on transcript segment + clip context
  for (const rule of SOCIAL_TOPIC_PATTERNS) {
    if (generated.length >= count) break;
    if (rule.pattern.test(contextText)) {
      tryPush(rule.tag);
    }
  }

  // 3. Fill any remaining slots up to 3 from additional keywords or category defaults
  for (const kw of rankedKeywords) {
    if (generated.length >= count) break;
    tryPush(kw);
  }

  const categoryFallbacks: Record<string, string[]> = {
    hook: ['#ViralHooks', '#Shorts', '#ContentCreator'],
    lesson: ['#QuickTip', '#LearnOnShorts', '#Shorts'],
    entertainment: ['#StoryTime', '#CreatorClips', '#Shorts'],
    insight: ['#DeepDive', '#ProTip', '#Shorts'],
  };
  for (const fallback of categoryFallbacks[clip.category || 'insight'] || ['#Shorts', '#Reels', '#Clips']) {
    if (generated.length >= count) break;
    tryPush(fallback);
  }
  for (const extra of ['#Shorts', '#Reels', '#Trending', '#Highlights']) {
    if (generated.length >= count) break;
    tryPush(extra);
  }

  return generated.slice(0, count);
}

const POSITIVE_SENTIMENT_WORDS = new Set([
  'amazing', 'awesome', 'best', 'better', 'breakthrough', 'brilliant', 'clean',
  'confident', 'delight', 'easy', 'effective', 'efficient', 'enjoy', 'excellent',
  'excited', 'exciting', 'fantastic', 'fast', 'fastest', 'favorite', 'free',
  'friendly', 'fun', 'gain', 'genius', 'glad', 'good', 'great', 'growth',
  'happy', 'helpful', 'highlight', 'huge', 'ideal', 'impressive', 'improve',
  'improved', 'incredible', 'insightful', 'inspire', 'inspiring', 'instant',
  'joy', 'laugh', 'love', 'loved', 'lovely', 'lucky', 'master', 'nice',
  'optimal', 'outstanding', 'perfect', 'positive', 'powerful', 'pro',
  'productive', 'progress', 'proud', 'reliable', 'remarkable', 'save', 'saved',
  'seamless', 'simple', 'smart', 'smooth', 'solve', 'solved', 'special',
  'strong', 'strongest', 'succeed', 'success', 'successful', 'super',
  'superpower', 'thank', 'thanks', 'thrilled', 'top', 'trust', 'useful',
  'valuable', 'victory', 'win', 'winner', 'winning', 'wonderful', 'wow', 'yes',
]);

const NEGATIVE_SENTIMENT_WORDS = new Set([
  'afraid', 'angry', 'annoying', 'awful', 'bad', 'broken', 'bug', 'bugs',
  'chaos', 'collapse', 'complain', 'confusing', 'crash', 'crashed', 'crashes',
  'crisis', 'critical', 'damage', 'danger', 'dangerous', 'dead', 'delay',
  'difficult', 'disaster', 'disappointing', 'doubt', 'error', 'errors', 'fail',
  'failed', 'failing', 'fails', 'failure', 'fake', 'fault', 'fear', 'flaw',
  'frustrating', 'frustration', 'garbage', 'hard', 'harm', 'hate', 'horrible',
  'hurt', 'impossible', 'issue', 'issues', 'lag', 'lagging', 'late', 'lose',
  'loser', 'losing', 'loss', 'lost', 'mess', 'mistake', 'mistakes', 'negative',
  'nightmare', 'pain', 'painful', 'panic', 'poor', 'problem', 'problems',
  'regret', 'reject', 'risk', 'risky', 'ruin', 'sad', 'scam', 'scary', 'slow',
  'sorry', 'spam', 'stuck', 'struggle', 'stupid', 'suffer', 'terrible',
  'threat', 'tired', 'toxic', 'trash', 'trouble', 'ugly', 'unable',
  'unfortunate', 'unhappy', 'useless', 'warn', 'warning', 'waste', 'wasted',
  'weak', 'worse', 'worst', 'wrong',
]);

const NEGATION_WORDS = new Set([
  'not', 'never', 'no', 'dont', 'doesnt', 'didnt', 'wont', 'cant', 'cannot',
  'isnt', 'arent', 'wasnt', 'werent', 'without', 'hardly', 'barely',
]);

function analyzeTranscriptSentiment(
  clip: Pick<ClipCandidate, 'start_sec' | 'end_sec' | 'title' | 'caption_hook' | 'reason'>,
  transcriptData: Transcript | null
): ClipSentiment {
  const segmentText = transcriptData?.segments
    .filter((s) => s.end_sec >= clip.start_sec && s.start_sec <= clip.end_sec)
    .map((s) => s.text)
    .join(' ')
    .trim();

  const sourceText =
    segmentText ||
    [clip.title, clip.caption_hook, clip.reason].filter(Boolean).join(' ').trim();

  if (!sourceText) return 'Neutral';

  const tokens = sourceText
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let score = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const negated =
      (i >= 1 && NEGATION_WORDS.has(tokens[i - 1])) ||
      (i >= 2 && NEGATION_WORDS.has(tokens[i - 2]));

    if (POSITIVE_SENTIMENT_WORDS.has(token)) {
      score += negated ? -1 : 1;
    } else if (NEGATIVE_SENTIMENT_WORDS.has(token)) {
      score += negated ? 0.5 : -1;
    }
  }

  if (score >= 1) return 'Positive';
  if (score <= -1) return 'Negative';
  return 'Neutral';
}

export default function App() {
  const desktopAuthParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (desktopAuthParams?.get('desktop_auth') === '1') {
    return (
      <ErrorBoundary>
        <DesktopAuthBridgeScreen
          callbackUrl={desktopAuthParams.get('callback') || ''}
          state={desktopAuthParams.get('state') || ''}
        />
      </ErrorBoundary>
    );
  }

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
  const [isGeneratingViralClips, setIsGeneratingViralClips] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Transcript drawer
  const [showTranscriptDrawer, setShowTranscriptDrawer] = useState(false);
  const [transcriptSearch, setTranscriptSearch] = useState('');
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
      setTranscriptSearch('');
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
      const enrichedClips = (data.clips || []).map((clip) => {
        const autoHashtags = generateTranscriptHashtags(clip, currentTranscript, 3);
        const sentiment = analyzeTranscriptSentiment(clip, currentTranscript);
        return {
          ...clip,
          sentiment,
          tags: [...(clip.tags || []), ...autoHashtags],
        };
      });
      setClips(enrichedClips);
      setActiveClipId(enrichedClips[0]?.id || null);
      if (enrichedClips.length > 0) {
        await persistClips(activeProject.video_hash, enrichedClips);
      }
      setNotice({
        kind: 'info',
        text: `Extracted ${enrichedClips.length} word-grounded clips with 3 transcript-based hashtags each.`,
      });
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setIsExtracting(false);
    }
  };

  const handleGenerateAiViralClips = async (retranscribe = false) => {
    if (!activeProject) return;
    setIsGeneratingViralClips(true);
    setNotice({
      kind: 'info',
      text: 'Transcribing entire video audio and analyzing transcript with Gemini AI for viral clips...',
    });
    try {
      let data: {
        transcript: Transcript;
        clips: ClipCandidate[];
        cache_hit: boolean;
        transcript_model: string;
        analysis_model: string;
        note?: string;
      };

      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(activeProject.video_hash)}/ai-viral-clips`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            retranscribe,
            ollama_url: ollamaUrl,
            ollama_model: ollamaModel,
            min_clip_sec: Math.min(8, Math.max(3, activeProject.duration_sec * 0.15)),
            max_clip_sec: 45,
            max_clips: 6,
          }),
        }
      );

      if (isTauriRuntime && res.status === 404) {
        // Older local sidecar binary fallback: compose /transcribe + /highlights locally
        let currentTranscript = retranscribe ? null : transcript;
        if (!currentTranscript) {
          currentTranscript = await handleTranscribe(activeProject.video_hash, retranscribe);
        }
        if (!currentTranscript || currentTranscript.segments.length === 0) {
          throw new Error('Could not transcribe local video before generating viral clips.');
        }
        const hlRes = await apiFetch(
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
        const hlData = await readJsonResponse<{ clips: ClipCandidate[] }>(hlRes);
        data = {
          transcript: currentTranscript,
          clips: hlData.clips || [],
          cache_hit: true,
          transcript_model: currentTranscript.model_name,
          analysis_model: 'local-sidecar',
        };
      } else {
        data = await readJsonResponse(res);
      }

      setTranscript(data.transcript);
      setCacheHit(true);

      const enrichedClips = (data.clips || []).map((clip) => {
        const existingTags = Array.isArray(clip.tags) ? clip.tags : [];
        const tags =
          existingTags.length >= 3
            ? existingTags
            : [...existingTags, ...generateTranscriptHashtags(clip, data.transcript, 3 - existingTags.length)];
        const sentiment = clip.sentiment || analyzeTranscriptSentiment(clip, data.transcript);
        return {
          ...clip,
          sentiment,
          tags,
        };
      });

      setClips(enrichedClips);
      setActiveClipId(enrichedClips[0]?.id || null);
      if (enrichedClips.length > 0) {
        await persistClips(activeProject.video_hash, enrichedClips);
      }
      await loadProjects(false);

      const baseMsg = `AI transcribed ${data.transcript.segments.length} segments and generated ${enrichedClips.length} viral clips.`;
      setNotice({
        kind: 'info',
        text: data.note ? `${baseMsg} (${data.note})` : baseMsg,
      });
    } catch (err: any) {
      setNotice({ kind: 'error', text: err?.message || 'AI viral clip generation failed.' });
    } finally {
      setIsGeneratingViralClips(false);
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
    const updatedSnapped: ClipCandidate = {
      ...snapped,
      sentiment: analyzeTranscriptSentiment(snapped, transcript),
    };
    const next = clips.map((c) => (c.id === clip.id ? updatedSnapped : c));
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

    const baseClip: ClipCandidate = {
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
    const created: ClipCandidate = {
      ...baseClip,
      sentiment: analyzeTranscriptSentiment(baseClip, transcript),
      tags: [...baseClip.tags, ...generateTranscriptHashtags(baseClip, transcript, 3)],
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
      const effectiveIncludeSrt =
        activeClip.subtitles?.enabled === false ? false : includeSrt;
      const effectiveBurnCaptions =
        activeClip.subtitles?.enabled === false ? false : burnCaptions;
      const res = await apiFetch('/api/clips/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_hash: activeProject.video_hash,
          clip: activeClip,
          subtitle_config: activeClip.subtitles || null,
          aspect_ratio: aspectRatio,
          encode_mode: encodeMode,
          include_srt: effectiveIncludeSrt,
          burn_captions: effectiveBurnCaptions,
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

  const handleSaveVoiceTranscriptToProject = async (rawText: string) => {
    if (!activeProject || !rawText.trim()) return;
    const sentences = rawText
      .trim()
      .split(/(?<=[.!?])\s+|\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = sentences.length > 0 ? sentences : [rawText.trim()];
    const totalDur = Math.max(4, activeProject.duration_sec || lines.length * 4);
    const step = totalDur / lines.length;
    const formatSrtTs = (sec: number) => {
      const clamped = Math.max(0, sec);
      const hrs = Math.floor(clamped / 3600);
      const mins = Math.floor((clamped % 3600) / 60);
      const secs = Math.floor(clamped % 60);
      const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const srt = lines
      .map((line, idx) => {
        const start = idx * step;
        const end = Math.max(start + 0.6, (idx + 1) * step - 0.1);
        return `${idx + 1}\n${formatSrtTs(start)} --> ${formatSrtTs(end)}\n${line}`;
      })
      .join('\n\n');

    const res = await apiFetch(
      `/api/projects/${encodeURIComponent(activeProject.video_hash)}/transcript`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srt }),
      }
    );
    const data = await readJsonResponse<{ transcript: Transcript }>(res);
    setTranscript(data.transcript);
    setCacheHit(true);
    setNotice({
      kind: 'info',
      text: `Saved voice transcription to "${activeProject.title}" transcript cache (${data.transcript.segments.length} segments).`,
    });
    setActiveTab('studio');
    setShowTranscriptDrawer(true);
  };

  const navItems: Array<{ id: WorkspaceTab; label: string; icon: React.ReactNode }> = [
    { id: 'studio', label: 'Clip Studio', icon: <Scissors className="w-4 h-4" /> },
    { id: 'transcribe', label: 'Transcribe Audio', icon: <Mic className="w-4 h-4" /> },
    { id: 'queue', label: 'Social & Queue', icon: <CalendarClock className="w-4 h-4" /> },
    { id: 'architecture', label: 'Architecture & Code', icon: <FolderGit2 className="w-4 h-4" /> },
    { id: 'hardware', label: 'Mobile & Hardware', icon: <Cpu className="w-4 h-4" /> },
  ];

  const breadcrumbTitle: Record<WorkspaceTab, string> = {
    studio: 'Clip Studio',
    transcribe: 'Transcribe Audio',
    queue: 'Social Share & Publish Queue',
    architecture: 'Architecture & Code',
    hardware: 'Mobile & Hardware Trade-offs',
  };

  return (
    <ErrorBoundary>
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
                      onClick={() => setActiveTab('transcribe')}
                      title="Dictate prompt or voice memo with microphone"
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Mic className="w-3.5 h-3.5 text-blue-400" />
                      Voice Input
                    </button>
                    <button
                      type="button"
                      disabled={isTranscribing || isGeneratingViralClips}
                      onClick={() => handleTranscribe(activeProject.video_hash, Boolean(transcript))}
                      className="px-3 py-2 text-xs font-medium bg-[#0B0F17] hover:bg-slate-800 disabled:opacity-40 text-slate-200 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
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
                      disabled={isExtracting || isTranscribing || isGeneratingViralClips}
                      onClick={handleExtractHighlights}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {isExtracting ? 'Extracting...' : 'Extract Clips'}
                    </button>
                    <button
                      type="button"
                      disabled={isGeneratingViralClips || isExtracting || isTranscribing}
                      onClick={() => handleGenerateAiViralClips(false)}
                      title="Transcribe the full video audio and analyze the transcript with Gemini AI to generate viral clips"
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {isGeneratingViralClips ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Generating Viral Clips...
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-3.5 h-3.5" />
                          AI Transcribe & Viral Clips
                        </>
                      )}
                    </button>
                    <span className="text-[11px] font-mono tabular-nums text-slate-400 ml-auto">
                      {cacheHit ? 'Transcript cached · 0ms ASR' : 'Uncached'} · SHA256{' '}
                      {activeProject.video_hash.slice(0, 8)}
                    </span>
                  </div>
                )}

                {/* Collapsible Cached Transcript & SRT Import Drawer */}
                {showTranscriptDrawer && activeProject && (() => {
                  const allSegments = transcript?.segments || [];
                  const query = transcriptSearch.trim().toLowerCase();
                  const filteredSegments = query
                    ? allSegments.filter(
                        (seg) =>
                          seg.text.toLowerCase().includes(query) ||
                          `${seg.start_sec.toFixed(2)}–${seg.end_sec.toFixed(2)}`.includes(query)
                      )
                    : allSegments;

                  return (
                    <div className="pt-3 border-t border-slate-800/80 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-200">
                            Cached Word-Timestamped Segments
                          </span>
                          <span className="text-[11px] font-mono tabular-nums text-slate-400">
                            {query
                              ? `${filteredSegments.length} / ${allSegments.length} matches`
                              : `${allSegments.length} segs`}
                          </span>
                        </div>
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <input
                            type="text"
                            value={transcriptSearch}
                            onChange={(e) => setTranscriptSearch(e.target.value)}
                            placeholder="Filter segments by spoken words or timestamp..."
                            aria-label="Search transcript segments"
                            className="w-full bg-[#0B0F17] border border-slate-800 focus:border-blue-500 rounded pl-8 pr-7 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                          />
                          {transcriptSearch && (
                            <button
                              type="button"
                              onClick={() => setTranscriptSearch('')}
                              aria-label="Clear transcript search"
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 max-h-48 overflow-y-auto space-y-2 text-xs">
                          {filteredSegments.length > 0 ? (
                            filteredSegments.map((seg) => (
                              <div key={seg.id} className="leading-relaxed">
                                <span className="font-mono tabular-nums text-blue-400 mr-2">
                                  [{seg.start_sec.toFixed(2)}–{seg.end_sec.toFixed(2)}]
                                </span>
                                <span className="text-slate-200">{seg.text}</span>
                              </div>
                            ))
                          ) : (
                            <div className="py-6 text-center text-slate-400 text-xs">
                              {query
                                ? `No transcript segments match "${transcriptSearch.trim()}".`
                                : 'No transcript segments cached yet.'}
                            </div>
                          )}
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
                  );
                })()}
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
                    onChangeClip={handleChangeClip}
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

          {activeTab === 'transcribe' && (
            <AudioTranscribeView
              activeProject={activeProject}
              onUseAsHighlightPrompt={(text) => {
                setPrompt(text);
                setActiveTab('studio');
                setNotice({
                  kind: 'info',
                  text: 'Applied voice transcription as your Clip Studio highlight extraction prompt.',
                });
              }}
              onSaveAsProjectTranscript={handleSaveVoiceTranscriptToProject}
            />
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
    </ErrorBoundary>
  );
}
