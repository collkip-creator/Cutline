export type AspectRatio = '16:9' | '9:16';
export type EncodeMode = 'stream_copy' | 'reencode';
export type PublishPlatform = 'youtube_shorts' | 'tiktok' | 'instagram_reels' | 'x_video';
export type PublishStatus = 'queued' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export interface WordTimestamp {
  word: string;
  start_sec: number;
  end_sec: number;
  confidence: number;
}

export interface TranscriptSegment {
  id: number;
  start_sec: number;
  end_sec: number;
  text: string;
  words: WordTimestamp[];
}

export interface Transcript {
  video_hash: string;
  source_path: string;
  language: string;
  duration_sec: number;
  model_name: string;
  created_at_iso: string;
  segments: TranscriptSegment[];
}

export type ClipCategory = 'lesson' | 'entertainment' | 'insight' | 'hook';
export type VideoCategory =
  | 'business'
  | 'comedy'
  | 'motivation'
  | 'politics'
  | 'sports'
  | 'relationships'
  | 'technology'
  | 'education'
  | 'gaming'
  | 'general';
export type VideoCategoryOption = 'auto' | VideoCategory;
export type GamingClipType =
  | 'gameplay_highlight'
  | 'commentary_highlight'
  | 'synced_gameplay_reaction';
export type ClipSentiment = 'Positive' | 'Negative' | 'Neutral';
export type SubtitlePreset = 'classic' | 'bold_box' | 'yellow_pop' | 'minimal';
export type SubtitlePosition = 'bottom' | 'middle' | 'top';

export interface SubtitleCue {
  id: string;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface SubtitleConfig {
  enabled: boolean;
  preset: SubtitlePreset;
  position: SubtitlePosition;
  font_size: number;
  show_hook_banner: boolean;
  custom_cues?: SubtitleCue[];
}

export type FocusMode = 'smart_auto' | 'center' | 'manual';

export interface FocusKeyframe {
  time_sec: number;
  x_norm: number;
  y_norm: number;
  confidence: number;
  label?: string;
}

export interface FocusConfig {
  mode: FocusMode;
  target_x: number;
  smoothing: number;
  keyframes: FocusKeyframe[];
  source?: string;
}

export interface ClipCandidate {
  id: string;
  title: string;
  category?: ClipCategory;
  video_category?: VideoCategory;
  viral_triggers?: string[];
  gaming_clip_type?: GamingClipType;
  sentiment?: ClipSentiment;
  start_sec: number;
  end_sec: number;
  hook_score: number;
  lesson_score?: number;
  entertainment_score?: number;
  reason: string;
  caption_hook: string;
  tags: string[];
  snapped_to_words?: boolean;
  subtitles?: SubtitleConfig;
  focus?: FocusConfig;
}

export interface ProjectRecord {
  video_hash: string;
  title: string;
  filename: string;
  local_path: string;
  audio_path?: string | null;
  audio_url?: string | null;
  video_url: string;
  source_url: string | null;
  video_category?: VideoCategory | null;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  created_at_iso: string;
  clips: ClipCandidate[];
  transcript_cached?: boolean;
}

export interface ExportResult {
  clip_id: string;
  video_path: string;
  srt_path: string | null;
  ass_path: string | null;
  video_url: string;
  srt_url: string | null;
  ass_url: string | null;
  aspect_ratio: AspectRatio;
  encode_mode: EncodeMode;
  duration_sec: number;
  file_size_bytes: number;
}

export interface PublishJob {
  job_id: string;
  clip_id: string;
  clip_title: string;
  video_path: string;
  srt_path: string | null;
  platform: PublishPlatform;
  caption_text: string;
  tags: string[];
  status: PublishStatus;
  scheduled_at_iso: string | null;
  created_at_iso: string;
  updated_at_iso: string;
  published_url: string | null;
  error_message: string | null;
  attempts: number;
}

export interface PublishChannelConfig {
  platform: PublishPlatform;
  enabled: boolean;
  endpoint_url: string;
  has_token: boolean;
  token_preview: string;
  payload_mode: 'multipart' | 'json';
  default_hashtags: string[];
  updated_at_iso: string | null;
}

export interface ArchTreeNode {
  path: string;
  layer: 'core' | 'adapter' | 'ui' | 'tests' | 'root';
  bytes: number;
}
