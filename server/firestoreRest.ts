import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export type SupportedSocialPlatform = 'tiktok' | 'instagram' | 'youtube';

export interface ServerSocialConnection {
  platform: SupportedSocialPlatform;
  accountName: string;
  handle: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

interface FirebaseAppletConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

let cachedFbConfig: FirebaseAppletConfig | null = null;

function getFirebaseConfig(): FirebaseAppletConfig {
  if (cachedFbConfig) return cachedFbConfig;
  const cfgPath = path.join(ROOT_DIR, 'firebase-applet-config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as FirebaseAppletConfig;
  cachedFbConfig = raw;
  return raw;
}

function getDbId(cfg: FirebaseAppletConfig): string {
  const id = (cfg.firestoreDatabaseId || '').trim();
  return id || '(default)';
}

function decodeFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return String(val.stringValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const values = Array.isArray(val.arrayValue?.values) ? val.arrayValue.values : [];
    return values.map(decodeFirestoreValue);
  }
  return undefined;
}

export async function getSocialConnectionFromFirestore(
  userId: string,
  platform: SupportedSocialPlatform,
  firebaseIdToken: string
): Promise<ServerSocialConnection | null> {
  const cfg = getFirebaseConfig();
  const dbId = encodeURIComponent(getDbId(cfg));
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${dbId}/documents/users/${encodeURIComponent(userId)}/socialConnections/${encodeURIComponent(platform)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${firebaseIdToken}`,
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Firestore read failed for ${platform} (${res.status}): ${detail}`);
  }

  const doc = (await res.json()) as { fields?: Record<string, any> };
  const f = doc.fields || {};
  return {
    platform: (decodeFirestoreValue(f.platform) as SupportedSocialPlatform) || platform,
    accountName: String(decodeFirestoreValue(f.accountName) || platform),
    handle: String(decodeFirestoreValue(f.handle) || ''),
    externalAccountId: String(decodeFirestoreValue(f.externalAccountId) || ''),
    accessToken: String(decodeFirestoreValue(f.accessToken) || ''),
    refreshToken: String(decodeFirestoreValue(f.refreshToken) || ''),
    expiresAt: Number(decodeFirestoreValue(f.expiresAt) || 0),
    scopes: (decodeFirestoreValue(f.scopes) as string[]) || [],
  };
}

export async function persistRefreshedTokensToFirestore(
  userId: string,
  platform: SupportedSocialPlatform,
  firebaseIdToken: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }
): Promise<void> {
  const cfg = getFirebaseConfig();
  const dbId = getDbId(cfg);
  const docName = `projects/${cfg.projectId}/databases/${dbId}/documents/users/${userId}/socialConnections/${platform}`;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${encodeURIComponent(dbId)}/documents:commit`;

  const res = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${firebaseIdToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      writes: [
        {
          updateMask: {
            fieldPaths: ['accessToken', 'refreshToken', 'expiresAt'],
          },
          update: {
            name: docName,
            fields: {
              accessToken: { stringValue: tokens.accessToken.slice(0, 4096) },
              refreshToken: { stringValue: tokens.refreshToken.slice(0, 4096) },
              expiresAt: { integerValue: String(Math.max(0, Math.floor(tokens.expiresAt))) },
            },
          },
          updateTransforms: [
            {
              fieldPath: 'updatedAt',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Firestore token refresh write failed for ${platform} (${res.status}): ${detail}`);
  }
}
