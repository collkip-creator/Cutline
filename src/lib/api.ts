/**
 * Resolves API and media URLs cleanly across both runtimes:
 * - Web / Express server (default): relative path ('')
 * - Tauri v2 Desktop WebView: routes directly to local FastAPI sidecar (127.0.0.1:43111)
 */
const isTauriRuntime =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);

export const API_BASE_URL: string =
  import.meta.env.VITE_SIDECAR_URL || (isTauriRuntime ? 'http://127.0.0.1:43111' : '');

export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
}
