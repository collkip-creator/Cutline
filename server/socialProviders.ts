import crypto from 'crypto';
import fs from 'fs';
import type { Request } from 'express';
import {
  getSocialConnectionFromFirestore,
  persistRefreshedTokensToFirestore,
  type ServerSocialConnection,
  type SupportedSocialPlatform,
} from './firestoreRest.ts';

export type SocialPrivacy = 'public' | 'unlisted' | 'private';

export interface SocialOAuthTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  raw: Record<string, any>;
}

export interface SocialProfileResult {
  accountName: string;
  handle: string;
  externalAccountId: string;
}

export interface SocialPublishResult {
  platform: SupportedSocialPlatform;
  ok: boolean;
  postId?: string;
  publishedUrl?: string;
  status: string;
  error?: string;
  tokenRefreshed?: boolean;
  refreshedConnection?: ServerSocialConnection;
}

export interface SocialProviderAdapter {
  readonly platform: SupportedSocialPlatform;
  readonly displayName: string;
  readonly requiredScopes: string[];
  getMissingSecrets(): string[];
  isConfigured(): boolean;
  buildAuthorizeUrl(args: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(args: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<SocialOAuthTokenResult>;
  fetchProfile(args: {
    accessToken: string;
    rawTokenData?: Record<string, any>;
  }): Promise<SocialProfileResult>;
  refreshToken(args: {
    accessToken: string;
    refreshToken: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }>;
  publishVideo(args: {
    accessToken: string;
    externalAccountId: string;
    videoUrl: string;
    localVideoPath?: string;
    caption: string;
    privacy: SocialPrivacy;
  }): Promise<{ postId?: string; publishedUrl?: string; status: string }>;
}

export function resolveAppBaseUrl(req?: Request): string {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured && configured !== 'MY_APP_URL') {
    return configured;
  }
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000')
      .split(',')[0]
      .trim();
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}

export function buildProviderRedirectUri(
  platform: SupportedSocialPlatform,
  req?: Request
): string {
  if (platform === 'instagram') {
    const custom = (process.env.INSTAGRAM_REDIRECT_URI || '').trim();
    if (custom) return custom;
  }
  return `${resolveAppBaseUrl(req)}/api/auth/${platform}/callback`;
}

export function resolvePublicMediaUrl(videoUrl: string, req?: Request): string {
  const trimmed = (videoUrl || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = resolveAppBaseUrl(req);
  const pathPart = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${pathPart}`;
}

async function readVideoBinary(videoUrl: string, localVideoPath?: string): Promise<Buffer> {
  if (localVideoPath && fs.existsSync(localVideoPath)) {
    return fs.readFileSync(localVideoPath);
  }
  if (/^https?:\/\//i.test(videoUrl)) {
    const res = await fetch(videoUrl);
    if (!res.ok) {
      throw new Error(`Unable to fetch clip media (${res.status} ${res.statusText})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Clip MP4 binary is missing on disk and no downloadable videoUrl was provided.');
}

// ---------------------------------------------------------------------------
// 1. TikTok Provider (OAuth v2 + Creator Info Query + Video Init Upload)
// ---------------------------------------------------------------------------
export const tikTokProvider: SocialProviderAdapter = {
  platform: 'tiktok',
  displayName: 'TikTok',
  requiredScopes: ['user.info.basic', 'video.publish'],

  getMissingSecrets(): string[] {
    const missing: string[] = [];
    if (!(process.env.TIKTOK_CLIENT_KEY || '').trim()) missing.push('TIKTOK_CLIENT_KEY');
    if (!(process.env.TIKTOK_CLIENT_SECRET || '').trim()) missing.push('TIKTOK_CLIENT_SECRET');
    return missing;
  },

  isConfigured(): boolean {
    return this.getMissingSecrets().length === 0;
  },

  buildAuthorizeUrl({ redirectUri, state }): string {
    const clientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
    const params = new URLSearchParams({
      client_key: clientKey,
      scope: this.requiredScopes.join(','),
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri }): Promise<SocialOAuthTokenResult> {
    const clientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
    const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json()) as Record<string, any>;
    if (!res.ok || data.error || !data.access_token) {
      throw new Error(
        data.error_description || data.error || `TikTok token exchange failed (${res.status})`
      );
    }

    const expiresInSec = Number(data.expires_in || 86400);
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token || ''),
      expiresAt: Date.now() + expiresInSec * 1000,
      scopes: String(data.scope || this.requiredScopes.join(','))
        .split(/[,\s]+/)
        .filter(Boolean),
      raw: data,
    };
  },

  async fetchProfile({ accessToken, rawTokenData }): Promise<SocialProfileResult> {
    const res = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,username',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const json = (await res.json().catch(() => ({}))) as {
      data?: { user?: Record<string, any> };
    };
    const user = json?.data?.user || {};
    const openId = String(user.open_id || rawTokenData?.open_id || 'tiktok_user');
    const username = String(user.username || '').trim();
    const displayName = String(user.display_name || username || 'TikTok Creator').trim();
    return {
      accountName: displayName,
      handle: username ? `@${username.replace(/^@/, '')}` : `@${displayName.toLowerCase().replace(/\s+/g, '')}`,
      externalAccountId: openId,
    };
  },

  async refreshToken({ refreshToken }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    if (!refreshToken) {
      throw new Error('TikTok refresh token is missing; please reconnect your TikTok account.');
    }
    const clientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
    const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();
    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json()) as Record<string, any>;
    if (!res.ok || data.error || !data.access_token) {
      throw new Error(
        data.error_description || data.error || `TikTok token refresh failed (${res.status})`
      );
    }
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token || refreshToken),
      expiresAt: Date.now() + Number(data.expires_in || 86400) * 1000,
    };
  },

  async publishVideo({ accessToken, videoUrl, localVideoPath, caption, privacy }) {
    // Step 1: Query Creator Info for allowed privacy levels
    const infoRes = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({}),
    });
    const infoJson = (await infoRes.json().catch(() => ({}))) as {
      data?: { privacy_level_options?: string[] };
      error?: { code?: string; message?: string };
    };
    if (!infoRes.ok || (infoJson.error?.code && infoJson.error.code !== 'ok')) {
      throw new Error(
        infoJson.error?.message || `TikTok creator_info/query failed (${infoRes.status})`
      );
    }

    const allowedPrivacy = infoJson.data?.privacy_level_options || ['SELF_ONLY'];
    const desiredMap: Record<SocialPrivacy, string> = {
      public: 'PUBLIC_TO_EVERYONE',
      unlisted: 'MUTUAL_FOLLOW_FRIENDS',
      private: 'SELF_ONLY',
    };
    const desired = desiredMap[privacy] || 'SELF_ONLY';
    const privacyLevel = allowedPrivacy.includes(desired)
      ? desired
      : allowedPrivacy[0] || 'SELF_ONLY';

    // Step 2: Initialize upload (prefer FILE_UPLOAD when local MP4 exists, else PULL_FROM_URL)
    const hasLocalFile = Boolean(localVideoPath && fs.existsSync(localVideoPath));
    let videoBytes: Buffer | null = null;
    if (hasLocalFile && localVideoPath) {
      videoBytes = fs.readFileSync(localVideoPath);
    }

    const sourceInfo = videoBytes
      ? {
          source: 'FILE_UPLOAD',
          video_size: videoBytes.length,
          chunk_size: videoBytes.length,
          total_chunk_count: 1,
        }
      : {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        };

    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: sourceInfo,
      }),
    });
    const initJson = (await initRes.json().catch(() => ({}))) as {
      data?: { publish_id?: string; upload_url?: string };
      error?: { code?: string; message?: string };
    };
    if (!initRes.ok || (initJson.error?.code && initJson.error.code !== 'ok')) {
      throw new Error(
        initJson.error?.message || `TikTok video/init failed (${initRes.status})`
      );
    }

    const publishId = initJson.data?.publish_id || '';
    const uploadUrl = initJson.data?.upload_url;
    if (videoBytes && uploadUrl) {
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(videoBytes.length),
          'Content-Range': `bytes 0-${videoBytes.length - 1}/${videoBytes.length}`,
        },
        body: new Uint8Array(videoBytes),
      });
      if (!putRes.ok) {
        throw new Error(`TikTok chunk upload failed (${putRes.status} ${putRes.statusText})`);
      }
    }

    return {
      postId: publishId,
      publishedUrl: 'https://www.tiktok.com/creator-center/content',
      status: 'uploaded',
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Instagram Reels Provider (Meta/Instagram Business Login + Graph Containers)
// ---------------------------------------------------------------------------
export const instagramProvider: SocialProviderAdapter = {
  platform: 'instagram',
  displayName: 'Instagram Reels',
  requiredScopes: ['instagram_business_basic', 'instagram_business_content_publish'],

  getMissingSecrets(): string[] {
    const missing: string[] = [];
    if (!(process.env.INSTAGRAM_CLIENT_ID || '').trim()) missing.push('INSTAGRAM_CLIENT_ID');
    if (!(process.env.INSTAGRAM_CLIENT_SECRET || '').trim()) missing.push('INSTAGRAM_CLIENT_SECRET');
    return missing;
  },

  isConfigured(): boolean {
    return this.getMissingSecrets().length === 0;
  },

  buildAuthorizeUrl({ redirectUri, state }): string {
    const clientId = (process.env.INSTAGRAM_CLIENT_ID || '').trim();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.requiredScopes.join(','),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri }): Promise<SocialOAuthTokenResult> {
    const clientId = (process.env.INSTAGRAM_CLIENT_ID || '').trim();
    const clientSecret = (process.env.INSTAGRAM_CLIENT_SECRET || '').trim();

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    const res = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const shortData = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !shortData.access_token) {
      throw new Error(
        shortData.error_message ||
          shortData.error?.message ||
          `Instagram token exchange failed (${res.status})`
      );
    }

    // Exchange short-lived token for 60-day long-lived token
    const llParams = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: clientSecret,
      access_token: String(shortData.access_token),
    });
    const llRes = await fetch(`https://graph.instagram.com/access_token?${llParams.toString()}`);
    const llData = (await llRes.json().catch(() => ({}))) as Record<string, any>;

    const finalToken = String(llData.access_token || shortData.access_token);
    const expiresInSec = Number(llData.expires_in || 60 * 60 * 24 * 60);

    return {
      accessToken: finalToken,
      refreshToken: finalToken, // Instagram uses ig_refresh_token on the long-lived token
      expiresAt: Date.now() + expiresInSec * 1000,
      scopes: Array.isArray(shortData.permissions)
        ? shortData.permissions.map((p: unknown) => String(p))
        : this.requiredScopes,
      raw: { ...shortData, ...llData },
    };
  },

  async fetchProfile({ accessToken, rawTokenData }): Promise<SocialProfileResult> {
    const url = `https://graph.instagram.com/v21.0/me?fields=id,user_id,username,name,account_type&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok && !rawTokenData?.user_id) {
      throw new Error(data.error?.message || `Instagram profile fetch failed (${res.status})`);
    }
    const id = String(data.user_id || data.id || rawTokenData?.user_id || 'ig_user');
    const username = String(data.username || 'instagram_creator');
    return {
      accountName: String(data.name || username),
      handle: `@${username.replace(/^@/, '')}`,
      externalAccountId: id,
    };
  },

  async refreshToken({ accessToken, refreshToken }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const tokenToRefresh = refreshToken || accessToken;
    const params = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: tokenToRefresh,
    });
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?${params.toString()}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data.access_token) {
      throw new Error(
        data.error?.message || `Instagram token refresh failed (${res.status}); please reconnect.`
      );
    }
    const nextToken = String(data.access_token);
    return {
      accessToken: nextToken,
      refreshToken: nextToken,
      expiresAt: Date.now() + Number(data.expires_in || 60 * 60 * 24 * 60) * 1000,
    };
  },

  async publishVideo({ accessToken, externalAccountId, videoUrl, caption }) {
    if (!/^https:\/\//i.test(videoUrl) || /127\.0\.0\.1|localhost/i.test(videoUrl)) {
      throw new Error(
        'Instagram Reels Graph API requires a publicly reachable HTTPS video_url (run from the hosted App URL or supply a public videoUrl).'
      );
    }

    // Step 1: Create REELS container
    const createParams = new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption.slice(0, 2200),
      share_to_feed: 'true',
      access_token: accessToken,
    });
    const createRes = await fetch(
      `https://graph.instagram.com/v21.0/${encodeURIComponent(externalAccountId)}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: createParams.toString(),
      }
    );
    const createJson = (await createRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!createRes.ok || !createJson.id) {
      throw new Error(
        createJson.error?.message || `Instagram container creation failed (${createRes.status})`
      );
    }
    const creationId = createJson.id;

    // Step 2: Poll container status until FINISHED (up to ~60s)
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await fetch(
        `https://graph.instagram.com/v21.0/${encodeURIComponent(creationId)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`
      );
      const statusJson = (await statusRes.json().catch(() => ({}))) as {
        status_code?: string;
        status?: string;
        error?: { message?: string };
      };
      if (statusJson.status_code === 'FINISHED') {
        ready = true;
        break;
      }
      if (statusJson.status_code === 'ERROR' || statusJson.status_code === 'EXPIRED') {
        throw new Error(
          `Instagram media container failed (${statusJson.status_code}): ${statusJson.status || 'Processing error'}`
        );
      }
    }
    if (!ready) {
      throw new Error('Instagram media container timed out while transcoding Reels.');
    }

    // Step 3: Publish container
    const pubParams = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken,
    });
    const pubRes = await fetch(
      `https://graph.instagram.com/v21.0/${encodeURIComponent(externalAccountId)}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pubParams.toString(),
      }
    );
    const pubJson = (await pubRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!pubRes.ok || !pubJson.id) {
      throw new Error(
        pubJson.error?.message || `Instagram media_publish failed (${pubRes.status})`
      );
    }

    return {
      postId: pubJson.id,
      publishedUrl: 'https://www.instagram.com/',
      status: 'published',
    };
  },
};

// ---------------------------------------------------------------------------
// 3. YouTube Shorts Provider (Google OAuth 2.0 + YouTube Data API v3)
// ---------------------------------------------------------------------------
export const youtubeProvider: SocialProviderAdapter = {
  platform: 'youtube',
  displayName: 'YouTube Shorts',
  requiredScopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],

  getMissingSecrets(): string[] {
    const missing: string[] = [];
    if (!(process.env.GOOGLE_CLIENT_ID || '').trim()) missing.push('GOOGLE_CLIENT_ID');
    if (!(process.env.GOOGLE_CLIENT_SECRET || '').trim()) missing.push('GOOGLE_CLIENT_SECRET');
    return missing;
  },

  isConfigured(): boolean {
    return this.getMissingSecrets().length === 0;
  },

  buildAuthorizeUrl({ redirectUri, state }): string {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.requiredScopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri }): Promise<SocialOAuthTokenResult> {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data.access_token) {
      throw new Error(
        data.error_description || data.error || `Google token exchange failed (${res.status})`
      );
    }

    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token || ''),
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      scopes: String(data.scope || this.requiredScopes.join(' '))
        .split(/\s+/)
        .filter(Boolean),
      raw: data,
    };
  },

  async fetchProfile({ accessToken }): Promise<SocialProfileResult> {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = (await res.json().catch(() => ({}))) as {
      items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }>;
    };
    const ch = data.items?.[0];
    const title = ch?.snippet?.title || 'YouTube Channel';
    const customUrl = ch?.snippet?.customUrl || title;
    return {
      accountName: title,
      handle: customUrl.startsWith('@') ? customUrl : `@${customUrl.replace(/\s+/g, '')}`,
      externalAccountId: ch?.id || 'youtube_channel',
    };
  },

  async refreshToken({ refreshToken }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    if (!refreshToken) {
      throw new Error('Google refresh token missing; please reconnect YouTube with consent.');
    }
    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data.access_token) {
      throw new Error(
        data.error_description || data.error || `Google token refresh failed (${res.status})`
      );
    }
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token || refreshToken),
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
  },

  async publishVideo({ accessToken, videoUrl, localVideoPath, caption, privacy }) {
    const videoBytes = await readVideoBinary(videoUrl, localVideoPath);
    const lines = caption.trim().split('\n');
    const title = (lines[0] || 'Cutline Short').slice(0, 100);
    const description = caption.includes('#Shorts') ? caption : `${caption}\n\n#Shorts`;

    // Resumable upload init
    const initRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(videoBytes.length),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({
          snippet: {
            title,
            description: description.slice(0, 5000),
            tags: ['Shorts'],
            categoryId: '22',
          },
          status: {
            privacyStatus: privacy,
            selfDeclaredMadeForKids: false,
          },
        }),
      }
    );

    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => initRes.statusText);
      throw new Error(`YouTube upload init failed (${initRes.status}): ${errText}`);
    }

    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) {
      throw new Error('YouTube upload init did not return a resumable Location URL.');
    }

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoBytes.length),
      },
      body: new Uint8Array(videoBytes),
    });
    const uploadJson = (await uploadRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!uploadRes.ok || !uploadJson.id) {
      throw new Error(
        uploadJson.error?.message || `YouTube video upload failed (${uploadRes.status})`
      );
    }

    return {
      postId: uploadJson.id,
      publishedUrl: `https://youtube.com/shorts/${uploadJson.id}`,
      status: 'published',
    };
  },
};

// ---------------------------------------------------------------------------
// Provider Registry + State Store + Dispatcher
// ---------------------------------------------------------------------------
export const SOCIAL_PROVIDERS: Record<SupportedSocialPlatform, SocialProviderAdapter> = {
  tiktok: tikTokProvider,
  instagram: instagramProvider,
  youtube: youtubeProvider,
};

export function getSocialProvider(platform: string): SocialProviderAdapter | null {
  if (platform === 'tiktok' || platform === 'instagram' || platform === 'youtube') {
    return SOCIAL_PROVIDERS[platform];
  }
  return null;
}

interface PendingOAuthSession {
  platform: SupportedSocialPlatform;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
  desktopCallback?: string;
  desktopState?: string;
}

const pendingOAuthSessions = new Map<string, PendingOAuthSession>();

export function createOAuthStateSession(
  platform: SupportedSocialPlatform,
  redirectUri: string,
  desktopOptions?: { desktopCallback?: string; desktopState?: string }
): { state: string; codeVerifier: string; codeChallenge: string } {
  // Prune stale sessions (> 10 minutes)
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pendingOAuthSessions.entries()) {
    if (v.createdAt < cutoff) pendingOAuthSessions.delete(k);
  }

  const state = crypto.randomBytes(20).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('hex');
  pendingOAuthSessions.set(state, {
    platform,
    redirectUri,
    codeVerifier,
    createdAt: Date.now(),
    desktopCallback: desktopOptions?.desktopCallback,
    desktopState: desktopOptions?.desktopState,
  });
  return { state, codeVerifier, codeChallenge };
}

export function consumeOAuthStateSession(state: string): PendingOAuthSession | null {
  const sess = pendingOAuthSessions.get(state) || null;
  if (sess) pendingOAuthSessions.delete(state);
  return sess;
}

/**
 * Multi-platform publisher & automatic token refresh dispatcher.
 * Checks token expiry (with 60s safety window), refreshes via provider secrets when expired,
 * persists refreshed tokens back to Firestore when firebaseIdToken is supplied, and publishes clip.
 */
export async function publishClipToPlatform(params: {
  userId: string;
  platform: SupportedSocialPlatform;
  videoUrl: string;
  localVideoPath?: string;
  caption: string;
  privacy: SocialPrivacy;
  firebaseIdToken?: string;
  connectionOverride?: ServerSocialConnection | null;
}): Promise<SocialPublishResult> {
  const {
    userId,
    platform,
    videoUrl,
    localVideoPath,
    caption,
    privacy,
    firebaseIdToken,
    connectionOverride,
  } = params;

  const provider = getSocialProvider(platform);
  if (!provider) {
    return {
      platform,
      ok: false,
      status: 'failed',
      error: `Unsupported platform: ${platform}`,
    };
  }

  try {
    let conn: ServerSocialConnection | null = connectionOverride || null;
    if (!conn && firebaseIdToken && userId) {
      conn = await getSocialConnectionFromFirestore(userId, platform, firebaseIdToken);
    }
    if (!conn || !conn.accessToken) {
      return {
        platform,
        ok: false,
        status: 'not_connected',
        error: `${provider.displayName} account is not connected for this user.`,
      };
    }

    let tokenRefreshed = false;
    let activeAccessToken = conn.accessToken;
    let activeRefreshToken = conn.refreshToken;
    let activeExpiresAt = conn.expiresAt;

    // Auto-refresh if expired or within 60s of expiry
    const isExpired = activeExpiresAt > 0 && Date.now() >= activeExpiresAt - 60_000;
    if (isExpired) {
      const missing = provider.getMissingSecrets();
      if (missing.length > 0) {
        throw new Error(
          `Access token expired and server secret(s) ${missing.join(', ')} are not configured to refresh.`
        );
      }
      const refreshed = await provider.refreshToken({
        accessToken: activeAccessToken,
        refreshToken: activeRefreshToken,
      });
      activeAccessToken = refreshed.accessToken;
      activeRefreshToken = refreshed.refreshToken;
      activeExpiresAt = refreshed.expiresAt;
      tokenRefreshed = true;

      if (firebaseIdToken && userId) {
        await persistRefreshedTokensToFirestore(userId, platform, firebaseIdToken, {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresAt: activeExpiresAt,
        });
      }
    }

    const missing = provider.getMissingSecrets();
    if (missing.length > 0 && tokenRefreshed === false && platform === 'tiktok') {
      // TikTok posting endpoints don't require client_secret, only accessToken.
    }

    const published = await provider.publishVideo({
      accessToken: activeAccessToken,
      externalAccountId: conn.externalAccountId,
      videoUrl,
      localVideoPath,
      caption,
      privacy,
    });

    const refreshedConn: ServerSocialConnection | undefined = tokenRefreshed
      ? {
          ...conn,
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresAt: activeExpiresAt,
        }
      : undefined;

    return {
      platform,
      ok: true,
      postId: published.postId,
      publishedUrl: published.publishedUrl,
      status: published.status,
      tokenRefreshed,
      refreshedConnection: refreshedConn,
    };
  } catch (err: any) {
    return {
      platform,
      ok: false,
      status: 'failed',
      error: err?.message || `Failed to publish to ${provider.displayName}`,
    };
  }
}
