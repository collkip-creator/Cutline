import type { User } from 'firebase/auth';
import {
  apiFetch,
  apiUrl,
  getCloudAppUrl,
  openExternalBrowserUrl,
  readJsonResponse,
} from './api';
import {
  saveSocialConnection,
  signInWithGoogleCredentialTokens,
  type SocialConnectionRecord,
  type SocialPlatformId,
} from './firebase';

function randomStateToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export interface DesktopAuthSessionController {
  cancel: () => void;
  bridgeUrl: string;
}

export interface DesktopPollResponse {
  status: 'pending' | 'ready';
  idToken?: string;
  accessToken?: string;
  email?: string;
  error?: string;
  connection?: Omit<SocialConnectionRecord, 'updatedAtIso'> | null;
}

export function startDesktopBrowserGoogleSignIn(options: {
  onSuccess: (user: User) => void;
  onError: (message: string, needsRebuild?: boolean) => void;
}): DesktopAuthSessionController {
  const state = randomStateToken();
  const callbackUrl = apiUrl('/api/desktop-auth/callback');
  const bridgeUrl = `${getCloudAppUrl()}/?desktop_auth=1&callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

  let cancelled = false;
  let timer: number | null = null;
  const startedAt = Date.now();

  const stop = () => {
    cancelled = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  void (async () => {
    const opened = await openExternalBrowserUrl(bridgeUrl);
    if (!opened && !cancelled) {
      options.onError(
        'Could not launch your system browser automatically. Open the sign-in URL manually or paste a Desktop Sign-In Code.'
      );
    }

    const pollOnce = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > 180_000) {
        stop();
        options.onError('Desktop Google sign-in timed out after 3 minutes. Please retry.');
        return;
      }

      try {
        const res = await apiFetch(`/api/desktop-auth/poll?state=${encodeURIComponent(state)}`);
        if (res.status === 404) {
          stop();
          options.onError(
            'Installed sidecar needs an update for automatic callback. Paste a Desktop Sign-In Code from the browser below, or rebuild the Windows installer.',
            true
          );
          return;
        }
        const data = await readJsonResponse<DesktopPollResponse>(res);
        if (data.status === 'ready') {
          stop();
          if (data.error) {
            options.onError(data.error);
            return;
          }
          const user = await signInWithGoogleCredentialTokens(
            data.idToken || '',
            data.accessToken || ''
          );
          options.onSuccess(user);
          return;
        }
      } catch (err: unknown) {
        // Keep polling across brief transient errors unless cancelled
      }

      if (!cancelled) {
        timer = window.setTimeout(pollOnce, 1200);
      }
    };

    timer = window.setTimeout(pollOnce, 1200);
  })();

  return { cancel: stop, bridgeUrl };
}

export function startDesktopBrowserSocialOAuth(options: {
  userId: string;
  platform: SocialPlatformId;
  onSuccess: (connection: Omit<SocialConnectionRecord, 'updatedAtIso'>) => void;
  onError: (message: string) => void;
}): DesktopAuthSessionController {
  const state = randomStateToken();
  const callbackUrl = apiUrl('/api/desktop-auth/callback');
  const bridgeUrl = `${getCloudAppUrl()}/api/auth/${encodeURIComponent(options.platform)}/start?mode=redirect&desktop_callback=${encodeURIComponent(callbackUrl)}&desktop_state=${encodeURIComponent(state)}`;

  let cancelled = false;
  let timer: number | null = null;
  const startedAt = Date.now();

  const stop = () => {
    cancelled = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  void (async () => {
    const opened = await openExternalBrowserUrl(bridgeUrl);
    if (!opened && !cancelled) {
      options.onError('Could not open system browser for social authorization.');
      stop();
      return;
    }

    const pollOnce = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > 180_000) {
        stop();
        options.onError(`Timed out waiting for ${options.platform} authorization in browser.`);
        return;
      }

      try {
        const res = await apiFetch(`/api/desktop-auth/poll?state=${encodeURIComponent(state)}`);
        if (res.status === 404) {
          stop();
          options.onError(
            'Rebuild the desktop installer so Cutline-sidecar supports /api/desktop-auth/poll, or connect the social account on the Web app (it syncs via Firestore automatically).'
          );
          return;
        }
        const data = await readJsonResponse<DesktopPollResponse>(res);
        if (data.status === 'ready') {
          stop();
          if (data.error) {
            options.onError(data.error);
            return;
          }
          if (!data.connection) {
            options.onError('Missing provider connection payload from OAuth callback.');
            return;
          }
          await saveSocialConnection(options.userId, data.connection);
          options.onSuccess(data.connection);
          return;
        }
      } catch (err: unknown) {
        // Keep polling until ready or timeout
      }

      if (!cancelled) {
        timer = window.setTimeout(pollOnce, 1200);
      }
    };

    timer = window.setTimeout(pollOnce, 1200);
  })();

  return { cancel: stop, bridgeUrl };
}

export async function signInWithManualDesktopCode(rawInput: string): Promise<User> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Paste the Desktop Sign-In Code copied from your browser.');
  }
  let idToken = '';
  let accessToken = '';
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { idToken?: string; accessToken?: string };
    idToken = String(parsed.idToken || '');
    accessToken = String(parsed.accessToken || '');
  } else {
    idToken = trimmed;
  }
  return signInWithGoogleCredentialTokens(idToken, accessToken);
}
