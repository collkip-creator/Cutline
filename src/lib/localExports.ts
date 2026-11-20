import type { AspectRatio, ExportResult } from '../types';
import { apiUrl } from './api';

const DB_NAME = 'cutline_studio_exports_v1';
const STORE_NAME = 'local_exports';
const MAX_CACHED_EXPORTS = 12;

export interface LocalExportEntry {
  key: string;
  video_hash: string;
  clip_id: string;
  clip_title: string;
  aspect_ratio: AspectRatio;
  duration_sec: number;
  file_size_bytes: number;
  video_path: string;
  video_url: string;
  srt_url: string | null;
  ass_url: string | null;
  saved_at_iso: string;
  video_blob: Blob;
  srt_blob: Blob | null;
  ass_blob: Blob | null;
}

export function makeLocalExportKey(videoHash: string, exp: Pick<ExportResult, 'clip_id' | 'aspect_ratio'>): string {
  return `${videoHash}::${exp.clip_id}::${exp.aspect_ratio}`;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Keep object URL alive long enough for WebView2 / Chromium download manager to start reading.
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 15_000);
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }
  return res.blob();
}

export async function downloadUrlViaBlob(url: string, filename: string): Promise<void> {
  const blob = await fetchBlob(url);
  triggerBlobDownload(blob, filename);
}

function openExportsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable in this browser environment'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('video_hash', 'video_hash', { unique: false });
        store.createIndex('saved_at_iso', 'saved_at_iso', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open local exports database'));
  });
}

async function pruneOldExports(db: IDBDatabase): Promise<void> {
  const all = await new Promise<LocalExportEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result || []) as LocalExportEntry[]);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= MAX_CACHED_EXPORTS) return;
  all.sort((a, b) => b.saved_at_iso.localeCompare(a.saved_at_iso));
  const stale = all.slice(MAX_CACHED_EXPORTS);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const item of stale) {
      store.delete(item.key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveLocalExport(entry: LocalExportEntry): Promise<void> {
  const db = await openExportsDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await pruneOldExports(db);
  } finally {
    db.close();
  }
}

export async function getLocalExport(key: string): Promise<LocalExportEntry | null> {
  const db = await openExportsDb();
  try {
    return await new Promise<LocalExportEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as LocalExportEntry | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function listLocalExports(videoHash?: string): Promise<LocalExportEntry[]> {
  const db = await openExportsDb();
  try {
    const rows = await new Promise<LocalExportEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = videoHash ? store.index('video_hash').getAll(videoHash) : store.getAll();
      req.onsuccess = () => resolve((req.result || []) as LocalExportEntry[]);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => b.saved_at_iso.localeCompare(a.saved_at_iso));
  } finally {
    db.close();
  }
}

export async function deleteLocalExport(key: string): Promise<void> {
  const db = await openExportsDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function cacheExportInLocalStorage(
  videoHash: string,
  clipTitle: string,
  exp: ExportResult
): Promise<LocalExportEntry> {
  const videoBlob = await fetchBlob(apiUrl(exp.video_url));
  const [srtBlob, assBlob] = await Promise.all([
    exp.srt_url ? fetchBlob(apiUrl(exp.srt_url)).catch(() => null) : Promise.resolve(null),
    exp.ass_url ? fetchBlob(apiUrl(exp.ass_url)).catch(() => null) : Promise.resolve(null),
  ]);
  const entry: LocalExportEntry = {
    key: makeLocalExportKey(videoHash, exp),
    video_hash: videoHash,
    clip_id: exp.clip_id,
    clip_title: clipTitle,
    aspect_ratio: exp.aspect_ratio,
    duration_sec: exp.duration_sec,
    file_size_bytes: videoBlob.size || exp.file_size_bytes,
    video_path: exp.video_path,
    video_url: exp.video_url,
    srt_url: exp.srt_url,
    ass_url: exp.ass_url,
    saved_at_iso: new Date().toISOString(),
    video_blob: videoBlob,
    srt_blob: srtBlob,
    ass_blob: assBlob,
  };
  await saveLocalExport(entry);
  return entry;
}

export function buildExportFilename(
  clipId: string,
  aspectRatio: AspectRatio,
  ext: 'mp4' | 'srt' | 'ass'
): string {
  const safeId = clipId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ratioTag = aspectRatio.replace(':', 'x');
  return `${safeId}_${ratioTag}.${ext}`;
}
