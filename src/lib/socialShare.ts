import type { AspectRatio, PublishPlatform } from '../types';
import { apiUrl, isTauriRuntime, openExternalBrowserUrl } from './api';
import { fetchBlob, triggerBlobDownload } from './localExports';

export interface PlatformSpec {
  id: PublishPlatform;
  label: string;
  shortLabel: string;
  maxDurationSec: number;
  maxChars: number;
  idealAspect: AspectRatio;
  defaultHashtags: string[];
  uploadLabel: string;
  buildStudioUrl: (postText: string) => string;
}

export const PLATFORM_SPECS: Record<PublishPlatform, PlatformSpec> = {
  youtube_shorts: {
    id: 'youtube_shorts',
    label: 'YouTube Shorts',
    shortLabel: 'Shorts',
    maxDurationSec: 60,
    maxChars: 100,
    idealAspect: '9:16',
    defaultHashtags: ['Shorts'],
    uploadLabel: 'Open YouTube Studio',
    buildStudioUrl: () => 'https://studio.youtube.com/',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    shortLabel: 'TikTok',
    maxDurationSec: 180,
    maxChars: 2200,
    idealAspect: '9:16',
    defaultHashtags: ['fyp', 'viral'],
    uploadLabel: 'Open TikTok Upload',
    buildStudioUrl: () => 'https://www.tiktok.com/tiktokstudio/upload',
  },
  instagram_reels: {
    id: 'instagram_reels',
    label: 'Instagram Reels',
    shortLabel: 'Reels',
    maxDurationSec: 90,
    maxChars: 2200,
    idealAspect: '9:16',
    defaultHashtags: ['reels'],
    uploadLabel: 'Open Instagram',
    buildStudioUrl: () => 'https://www.instagram.com/',
  },
  x_video: {
    id: 'x_video',
    label: 'X Video',
    shortLabel: 'X',
    maxDurationSec: 140,
    maxChars: 280,
    idealAspect: '16:9',
    defaultHashtags: [],
    uploadLabel: 'Open X Compose',
    buildStudioUrl: (postText: string) =>
      `https://x.com/intent/tweet?text=${encodeURIComponent(postText.slice(0, 280))}`,
  },
};

export const ALL_PLATFORMS: PublishPlatform[] = [
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
  'x_video',
];

export function parseHashtagInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((t) => t.trim().replace(/^#+/, ''))
        .filter(Boolean)
    )
  );
}

export function mergePlatformTags(
  userTags: string[],
  platform: PublishPlatform,
  includePlatformDefaults: boolean,
  channelDefaults?: string[]
): string[] {
  const combined = [...userTags];
  if (includePlatformDefaults) {
    const defaults = channelDefaults && channelDefaults.length > 0
      ? channelDefaults
      : PLATFORM_SPECS[platform].defaultHashtags;
    combined.push(...defaults);
  }
  return Array.from(
    new Set(combined.map((t) => t.trim().replace(/^#+/, '')).filter(Boolean))
  );
}

export function buildFormattedPostText(caption: string, tags: string[]): string {
  const cleanCaption = caption.trim();
  const hashLine = tags
    .map((t) => `#${t.trim().replace(/^#+/, '')}`)
    .filter((t) => t.length > 1)
    .join(' ');
  if (!hashLine) return cleanCaption;
  return cleanCaption ? `${cleanCaption}\n\n${hashLine}` : hashLine;
}

export function trimCopyForLimit(caption: string, tags: string[], maxChars: number): string {
  const hashLine = tags
    .map((t) => `#${t.trim().replace(/^#+/, '')}`)
    .filter((t) => t.length > 1)
    .join(' ');
  const suffix = hashLine ? `\n\n${hashLine}` : '';
  const available = Math.max(24, maxChars - suffix.length - 1);
  const base = caption.trim();
  if (base.length + suffix.length <= maxChars) return base;
  return `${base.slice(0, Math.max(10, available)).trim()}…`;
}

export function getPlatformWarnings(
  platform: PublishPlatform,
  postText: string,
  durationSec?: number,
  aspectRatio?: AspectRatio
): string[] {
  const spec = PLATFORM_SPECS[platform];
  const warnings: string[] = [];
  if (postText.length > spec.maxChars) {
    warnings.push(`Copy exceeds ${spec.maxChars} chars (${postText.length})`);
  }
  if (typeof durationSec === 'number' && durationSec > spec.maxDurationSec) {
    warnings.push(`Clip is ${durationSec.toFixed(0)}s (limit ${spec.maxDurationSec}s)`);
  }
  if (aspectRatio && platform !== 'x_video' && aspectRatio !== spec.idealAspect) {
    warnings.push(`Recommended aspect is ${spec.idealAspect}`);
  }
  return warnings;
}

export function supportsNavigatorShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function supportsNativeFileShare(): boolean {
  if (!supportsNavigatorShare() || typeof navigator.canShare !== 'function') return false;
  try {
    const probe = new File([new Uint8Array([0])], 'probe.mp4', { type: 'video/mp4' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function resolveExportMediaUrlFromPath(videoPath: string): string | null {
  if (!videoPath) return null;
  const normalized = videoPath.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop();
  if (!fileName || !fileName.toLowerCase().endsWith('.mp4')) return null;
  return apiUrl(`/media/exports/${encodeURIComponent(fileName)}`);
}

export async function shareViaSystemSheet(options: {
  title: string;
  postText: string;
  filename: string;
  videoBlob?: Blob | null;
  fallbackMediaUrl?: string | null;
}): Promise<'shared-file' | 'shared-text' | 'cancelled'> {
  if (!supportsNavigatorShare()) {
    throw new Error('System Share Sheet is unavailable in this WebView; use Download Share Kit instead.');
  }
  let blob = options.videoBlob || null;
  if (!blob && options.fallbackMediaUrl) {
    blob = await fetchBlob(options.fallbackMediaUrl);
  }
  try {
    if (blob && typeof navigator.canShare === 'function') {
      const file = new File([blob], options.filename, { type: 'video/mp4' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: options.title,
          text: options.postText,
          files: [file],
        });
        return 'shared-file';
      }
    }
    await navigator.share({
      title: options.title,
      text: options.postText,
    });
    return 'shared-text';
  } catch (err: any) {
    if (err?.name === 'AbortError') return 'cancelled';
    throw err;
  }
}

export async function downloadShareKitPackage(options: {
  filename: string;
  postText: string;
  videoBlob?: Blob | null;
  fallbackMediaUrl?: string | null;
}): Promise<{ copied: boolean; downloaded: boolean }> {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(options.postText);
      copied = true;
    }
  } catch {
    copied = false;
  }

  let downloaded = false;
  let blob = options.videoBlob || null;
  if (!blob && options.fallbackMediaUrl) {
    blob = await fetchBlob(options.fallbackMediaUrl);
  }
  if (blob) {
    triggerBlobDownload(blob, options.filename);
    downloaded = true;
  }
  return { copied, downloaded };
}

export async function openPlatformStudio(url: string): Promise<boolean> {
  if (isTauriRuntime) {
    return openExternalBrowserUrl(url);
  }
  if (typeof window === 'undefined') return false;
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  return Boolean(win);
}
