/**
 * Resolves API and media URLs cleanly across both runtimes:
 * - Web / Express server (default): relative path ('')
 * - Tauri v2 Desktop WebView: routes local media/FFmpeg calls to 127.0.0.1:43111
 *   and social OAuth / publishing calls to the hosted Express cloud backend.
 */
export const isTauriRuntime =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);

export const API_BASE_URL: string =
  import.meta.env.VITE_SIDECAR_URL || (isTauriRuntime ? 'http://127.0.0.1:43111' : '');

export const DEFAULT_DEV_APP_URL =
  'https://ais-dev-qvfa2liarlhd3elkox55tu-415526218247.europe-west2.run.app';
export const DEFAULT_SHARED_APP_URL =
  'https://ais-pre-qvfa2liarlhd3elkox55tu-415526218247.europe-west2.run.app';

const CLOUD_URL_STORAGE_KEY = 'cutline_cloud_app_url';

export function getCloudAppUrl(): string {
  if (!isTauriRuntime && typeof window !== 'undefined') {
    return window.location.origin;
  }
  try {
    const saved = localStorage.getItem(CLOUD_URL_STORAGE_KEY)?.trim().replace(/\/+$/, '');
    if (saved && /^https?:\/\//i.test(saved)) return saved;
  } catch {
    // ignore storage access issues
  }
  const envUrl = String(import.meta.env.VITE_CLOUD_APP_URL || '').trim().replace(/\/+$/, '');
  return envUrl || DEFAULT_DEV_APP_URL;
}

export function setCloudAppUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '');
  try {
    if (cleaned) {
      localStorage.setItem(CLOUD_URL_STORAGE_KEY, cleaned);
    } else {
      localStorage.removeItem(CLOUD_URL_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  return getCloudAppUrl();
}

export interface SidecarDiagnostics {
  running: boolean;
  port_listening?: boolean;
  spawn_error: string | null;
  terminated: string | null;
  logs: string[];
  log_file_path: string;
  log_file_tail: string;
}

export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
}

export function socialApiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return isTauriRuntime ? `${getCloudAppUrl()}${normalized}` : normalized;
}

export async function socialApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const target = socialApiUrl(path);
  try {
    return await fetch(target, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || 'Network error');
    if (isTauriRuntime) {
      throw new Error(
        `Could not reach Cutline Cloud OAuth backend (${getCloudAppUrl()}): ${msg}. Verify the Cloud App URL in Social Accounts settings.`
      );
    }
    throw new Error(`Request to ${path} failed (${msg}).`);
  }
}

export async function openExternalBrowserUrl(url: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (isTauriRuntime) {
    const internals = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
    if (internals?.invoke) {
      try {
        await internals.invoke('open_external_url', { url });
        return true;
      } catch {
        try {
          await internals.invoke('plugin:shell|open', { path: url });
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  return Boolean(win);
}

export async function getTauriSidecarDiagnostics(): Promise<SidecarDiagnostics | null> {
  if (!isTauriRuntime) return null;
  const internals = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
  if (!internals?.invoke) return null;
  try {
    return (await internals.invoke('get_sidecar_diagnostics')) as SidecarDiagnostics;
  } catch {
    return null;
  }
}

export async function restartTauriSidecar(): Promise<void> {
  if (!isTauriRuntime) return;
  const internals = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
  if (internals?.invoke) {
    await internals.invoke('restart_sidecar');
  }
}

export async function checkSidecarHealth(timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl('/api/health'), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = apiUrl(path);
  const method = (init?.method || 'GET').toUpperCase();
  // Never blindly retry large POST uploads/mutations many times; retry idempotent GETs briefly.
  const maxAttempts = isTauriRuntime && method === 'GET' ? 4 : 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || 'Network error');
  if (isTauriRuntime) {
    const diag = await getTauriSidecarDiagnostics();
    const detail = diag?.spawn_error || diag?.terminated;
    if (detail) {
      throw new Error(
        `Local sidecar stopped (${detail}). Log: ${diag?.log_file_path || '%USERPROFILE%\\.cutline_studio\\sidecar.log'}`
      );
    }
    if (diag && diag.running && !diag.port_listening) {
      throw new Error(
        `Local sidecar is still starting (port 43111 not open yet). Wait a few seconds or check ${diag.log_file_path}.`
      );
    }
    throw new Error(
      `Local sidecar unreachable (${msg}). Check %USERPROFILE%\\.cutline_studio\\sidecar.log if cutline-sidecar failed to start on 127.0.0.1:43111.`
    );
  }
  throw new Error(
    `Request to ${path} failed (${msg}). If uploading a large file over the web preview, try a shorter MP4 (<25 MB) or run the desktop Tauri app locally.`
  );
}

export async function readJsonResponse<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
      }
      throw new Error(`Unexpected non-JSON response (HTTP ${res.status})`);
    }
  }
  if (!res.ok) {
    throw new Error(parsed?.error || parsed?.detail || `HTTP ${res.status} error`);
  }
  return parsed as T;
}
