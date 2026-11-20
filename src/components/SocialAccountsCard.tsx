import React, { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Check,
  Copy,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Unlink,
  X,
} from 'lucide-react';
import { apiFetch, readJsonResponse } from '../lib/api';
import {
  disconnectSocialConnection,
  saveSocialConnection,
  signInWithGoogleForSocial,
  signOutFirebase,
  type SocialConnectionRecord,
  type SocialPlatformId,
} from '../lib/firebase';

export interface ProviderConfigStatus {
  platform: SocialPlatformId;
  displayName: string;
  configured: boolean;
  missingSecrets: string[];
  redirectUri: string;
  scopes: string[];
}

interface SocialAccountsCardProps {
  authUser: User | null;
  authReady: boolean;
  connections: Record<SocialPlatformId, SocialConnectionRecord | null>;
  onStatusBanner?: (banner: { kind: 'info' | 'error'; text: string }) => void;
}

const PLATFORM_META: Record<
  SocialPlatformId,
  { title: string; subtitle: string; badgeColor: string }
> = {
  tiktok: {
    title: 'TikTok',
    subtitle: 'OAuth v2 · Content Posting API',
    badgeColor: 'text-cyan-300',
  },
  instagram: {
    title: 'Instagram Reels',
    subtitle: 'Meta Business · Reels Graph Container',
    badgeColor: 'text-pink-300',
  },
  youtube: {
    title: 'YouTube Shorts',
    subtitle: 'Google OAuth 2.0 · Data API v3',
    badgeColor: 'text-rose-300',
  },
};

function formatExpiry(expiresAt: number): { label: string; expired: boolean } {
  if (!expiresAt || expiresAt <= 0) {
    return { label: 'Active', expired: false };
  }
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 60_000) {
    return { label: 'Expired · auto-refreshes on post', expired: true };
  }
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) {
    return { label: `Expires in ${mins}m`, expired: false };
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return { label: `Expires in ${hours}h`, expired: false };
  }
  const days = Math.floor(hours / 24);
  return { label: `Expires in ${days}d`, expired: false };
}

export const SocialAccountsCard: React.FC<SocialAccountsCardProps> = ({
  authUser,
  authReady,
  connections,
  onStatusBanner,
}) => {
  const [providerStatuses, setProviderStatuses] = useState<ProviderConfigStatus[]>([]);
  const [busyPlatform, setBusyPlatform] = useState<SocialPlatformId | 'auth' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);

  const loadProviderStatuses = async () => {
    try {
      const res = await apiFetch('/api/auth/providers/status');
      const data = await readJsonResponse<{ providers: ProviderConfigStatus[] }>(res);
      setProviderStatuses(data.providers || []);
    } catch {
      // Ignore transient cold start errors
    }
  };

  useEffect(() => {
    void loadProviderStatuses();
  }, []);

  // Listen for OAuth popup cross-origin postMessage callbacks
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const origin = event.origin || '';
      const allowedOrigin =
        origin === window.location.origin ||
        origin.endsWith('.run.app') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1');
      if (!allowedOrigin) return;

      if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        const msg = String(event.data?.error || 'OAuth authorization failed.');
        setLocalError(msg);
        onStatusBanner?.({ kind: 'error', text: msg });
        setBusyPlatform(null);
        return;
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.connection) {
        const conn = event.data.connection as Omit<SocialConnectionRecord, 'updatedAtIso'>;
        if (!authUser) {
          setLocalError('Sign in with Google first so tokens can be saved to your Firestore profile.');
          setBusyPlatform(null);
          return;
        }
        try {
          await saveSocialConnection(authUser.uid, conn);
          setLocalError(null);
          onStatusBanner?.({
            kind: 'info',
            text: `Connected ${PLATFORM_META[conn.platform]?.title || conn.platform} (${conn.handle || conn.accountName}) to Firestore.`,
          });
        } catch (err: any) {
          const msg = err?.message || 'Failed to persist social connection to Firestore.';
          setLocalError(msg);
          onStatusBanner?.({ kind: 'error', text: msg });
        } finally {
          setBusyPlatform(null);
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [authUser, onStatusBanner]);

  const handleGoogleSignIn = async () => {
    setBusyPlatform('auth');
    setLocalError(null);
    try {
      const user = await signInWithGoogleForSocial();
      onStatusBanner?.({
        kind: 'info',
        text: `Signed in as ${user.email || user.uid}. Firestore socialConnections ready.`,
      });
    } catch (err: any) {
      setLocalError(err?.message || 'Google Sign-In failed or was cancelled.');
    } finally {
      setBusyPlatform(null);
    }
  };

  const handleConnectPlatform = async (platform: SocialPlatformId) => {
    if (!authUser) {
      setLocalError('Sign in with Google above before connecting social publishing accounts.');
      return;
    }
    setBusyPlatform(platform);
    setLocalError(null);
    try {
      const res = await apiFetch(`/api/auth/${encodeURIComponent(platform)}/start`);
      const data = await readJsonResponse<{ url: string; redirectUri: string }>(res);

      // Open OAuth provider authorization URL directly in popup (required for AI Studio iframe)
      const popup = window.open(
        data.url,
        `cutline_oauth_${platform}`,
        'width=600,height=720,menubar=no,toolbar=no,status=no'
      );
      if (!popup) {
        setLocalError('Popup was blocked by browser settings. Allow popups for this site and retry.');
        setBusyPlatform(null);
      }
    } catch (err: any) {
      setLocalError(err?.message || `Unable to start ${platform} OAuth flow.`);
      setBusyPlatform(null);
    }
  };

  const handleDisconnectPlatform = async (platform: SocialPlatformId) => {
    if (!authUser) return;
    setBusyPlatform(platform);
    setLocalError(null);
    try {
      await disconnectSocialConnection(authUser.uid, platform);
      onStatusBanner?.({
        kind: 'info',
        text: `Disconnected ${PLATFORM_META[platform].title} from Firestore.`,
      });
    } catch (err: any) {
      setLocalError(err?.message || `Failed to disconnect ${platform}.`);
    } finally {
      setBusyPlatform(null);
    }
  };

  const handleManualRefresh = async (platform: SocialPlatformId) => {
    const conn = connections[platform];
    if (!authUser || !conn) return;
    setBusyPlatform(platform);
    setLocalError(null);
    try {
      const idToken = await authUser.getIdToken();
      const res = await apiFetch('/api/social/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          userId: authUser.uid,
          platform,
          connection: conn,
        }),
      });
      const data = await readJsonResponse<{ connection: Omit<SocialConnectionRecord, 'updatedAtIso'> }>(res);
      await saveSocialConnection(authUser.uid, data.connection);
      onStatusBanner?.({
        kind: 'info',
        text: `Refreshed OAuth access token for ${PLATFORM_META[platform].title}.`,
      });
    } catch (err: any) {
      setLocalError(err?.message || `Token refresh failed for ${platform}.`);
    } finally {
      setBusyPlatform(null);
    }
  };

  const handleCopyUri = async (uri: string) => {
    try {
      await navigator.clipboard?.writeText(uri);
      setCopiedUri(uri);
      window.setTimeout(() => setCopiedUri(null), 1800);
    } catch {
      // ignore
    }
  };

  const platforms: SocialPlatformId[] = ['tiktok', 'instagram', 'youtube'];
  const connectedCount = platforms.filter((p) => Boolean(connections[p])).length;

  return (
    <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-4">
      {/* Header + Firebase Account Auth */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Social Accounts</h3>
            <span className="font-mono text-[11px] text-slate-400">
              ({connectedCount}/3 connected)
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            OAuth tokens stored per user in Firestore{' '}
            <code className="text-slate-300">users/{'{userId}'}/socialConnections/{'{platform}'}</code>{' '}
            with automatic server-side refresh before posting.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!authReady ? (
            <span className="text-xs text-slate-400">Checking Firebase session...</span>
          ) : authUser ? (
            <div className="flex items-center gap-2 bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5 text-xs">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-slate-200 truncate max-w-[200px]">
                {authUser.email || authUser.displayName || authUser.uid}
              </span>
              <button
                type="button"
                onClick={() => signOutFirebase()}
                title="Sign out of Firebase"
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white pl-2 border-l border-slate-800"
              >
                <LogOut className="w-3 h-3" />
                Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busyPlatform === 'auth'}
              onClick={handleGoogleSignIn}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              {busyPlatform === 'auth' ? 'Signing in...' : 'Sign in with Google'}
            </button>
          )}
        </div>
      </div>

      {localError && (
        <div className="px-3 py-2 rounded border border-rose-500/40 bg-rose-950/40 text-xs text-rose-200 flex items-center justify-between gap-2">
          <span>{localError}</span>
          <button
            type="button"
            onClick={() => setLocalError(null)}
            className="text-rose-300 hover:text-white shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3 Provider Connect/Disconnect Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {platforms.map((pid) => {
          const meta = PLATFORM_META[pid];
          const conn = connections[pid];
          const status = providerStatuses.find((s) => s.platform === pid);
          const expiry = conn ? formatExpiry(conn.expiresAt) : null;
          const isBusy = busyPlatform === pid;

          return (
            <div
              key={pid}
              className={`bg-[#0B0F17] border rounded-md p-3.5 flex flex-col justify-between gap-3 ${
                conn ? 'border-emerald-500/35' : 'border-slate-800'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className={`text-sm font-semibold ${meta.badgeColor}`}>
                      {meta.title}
                    </div>
                    <div className="text-[11px] text-slate-400">{meta.subtitle}</div>
                  </div>
                  <span
                    className={`text-[11px] font-medium ${
                      conn ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    {conn ? 'Connected' : 'Not connected'}
                  </span>
                </div>

                {conn ? (
                  <div className="bg-[#111724] border border-slate-800 rounded p-2.5 space-y-1 text-[11px]">
                    <div className="font-medium text-slate-100 truncate">
                      {conn.accountName}{' '}
                      {conn.handle && <span className="text-slate-400 font-normal">{conn.handle}</span>}
                    </div>
                    <div className="font-mono text-[10px] text-slate-500 truncate">
                      ID: {conn.externalAccountId}
                    </div>
                    {expiry && (
                      <div
                        className={`text-[10px] font-mono ${
                          expiry.expired ? 'text-amber-400' : 'text-emerald-400'
                        }`}
                      >
                        {expiry.label}
                      </div>
                    )}
                    {conn.scopes.length > 0 && (
                      <div className="text-[10px] text-slate-400 truncate" title={conn.scopes.join(', ')}>
                        Scopes: {conn.scopes.join(', ')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-[#111724] border border-slate-800/80 rounded p-2.5 space-y-1.5 text-[11px]">
                    {status && !status.configured ? (
                      <div className="text-amber-300 flex items-start gap-1.5">
                        <KeyRound className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>
                          Set server secrets:{' '}
                          <code className="font-mono text-[10px]">
                            {status.missingSecrets.join(', ')}
                          </code>
                        </span>
                      </div>
                    ) : (
                      <div className="text-slate-400">
                        {authUser
                          ? `Ready to authorize ${meta.title} publishing scopes.`
                          : 'Sign in with Google to save provider tokens.'}
                      </div>
                    )}
                    {status?.redirectUri && (
                      <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-slate-800/80">
                        <span
                          className="font-mono text-[10px] text-slate-500 truncate"
                          title={status.redirectUri}
                        >
                          {status.redirectUri}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyUri(status.redirectUri)}
                          title="Copy OAuth callback URL"
                          className="text-slate-400 hover:text-white shrink-0"
                        >
                          {copiedUri === status.redirectUri ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {conn ? (
                  <>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleConnectPlatform(pid)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded transition-colors"
                    >
                      <Link2 className="w-3 h-3" />
                      Reconnect
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleManualRefresh(pid)}
                      title="Test OAuth token refresh on server"
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-[#111724] hover:bg-slate-800 border border-slate-700 text-slate-300 rounded transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 ${isBusy ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDisconnectPlatform(pid)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-rose-400 hover:text-rose-300 ml-auto"
                    >
                      <Unlink className="w-3 h-3" />
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy || !authUser}
                    onClick={() => handleConnectPlatform(pid)}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white rounded transition-colors"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    {isBusy ? 'Authorizing...' : `Connect ${meta.title}`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
