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

export interface ClipCandidate {
  id: string;
  title: string;
  start_sec: number;
  end_sec: number;
  hook_score: number;
  reason: string;
  caption_hook: string;
  tags: string[];
  snapped_to_words?: boolean;
}

export interface ProjectRecord {
  video_hash: string;
  title: string;
  filename: string;
  local_path: string;
  video_url: string;
  source_url: string | null;
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

export interface ArchTreeNode {
  path: string;
  layer: 'core' | 'adapter' | 'ui' | 'tests' | 'root';
  bytes: number;
}
