/**
 * Resolves API and media URLs cleanly across both runtimes:
 * - Web / Express server (default): relative path ('')
 * - Tauri v2 Desktop WebView: routes directly to local FastAPI sidecar (127.0.0.1:43111)
 */
export const isTauriRuntime =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);

export const API_BASE_URL: string =
  import.meta.env.VITE_SIDECAR_URL || (isTauriRuntime ? 'http://127.0.0.1:43111' : '');

export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = apiUrl(path);
  const maxAttempts = isTauriRuntime ? 20 : 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || 'Network error');
  throw new Error(
    isTauriRuntime
      ? `Local sidecar unreachable (${msg}). Check %USERPROFILE%\\.cutline_studio\\sidecar.log if cutline-sidecar failed to start on 127.0.0.1:43111.`
      : `Request to ${path} failed (${msg}). If uploading a large file over the web preview, try a shorter MP4 (<25 MB) or run the desktop Tauri app locally.`
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
