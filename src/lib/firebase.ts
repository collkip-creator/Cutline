import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserPopupRedirectResolver,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Unsubscribe,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export type SocialPlatformId = 'tiktok' | 'instagram' | 'youtube';

export interface SocialConnectionRecord {
  platform: SocialPlatformId;
  accountName: string;
  handle: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  updatedAtIso?: string | null;
}

export function subscribeAuthUser(cb: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, cb);
}

export async function ensureUserProfileDoc(user: User): Promise<void> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    const displayName = (user.displayName || user.email || 'Cutline Creator').slice(0, 160);
    const email = (user.email || '').slice(0, 254);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        displayName,
        email,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        ref,
        {
          uid: user.uid,
          displayName,
          email,
          createdAt: snap.data().createdAt,
          updatedAt: serverTimestamp(),
        },
        { merge: false }
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

function buildGoogleAuthProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

export interface FirebaseAuthErrorInfo {
  code: string;
  isPopupBlocked: boolean;
  message: string;
}

export function classifyFirebaseAuthError(error: unknown): FirebaseAuthErrorInfo {
  const errObj = error as { code?: string; message?: string } | null;
  const rawCode = String(errObj?.code || '');
  const rawMsg = error instanceof Error ? error.message : String(error || 'Authentication failed.');

  if (rawCode === 'auth/popup-blocked' || rawMsg.includes('auth/popup-blocked')) {
    return {
      code: 'auth/popup-blocked',
      isPopupBlocked: true,
      message:
        'Your browser blocked the Google Sign-In popup (common inside embedded preview frames). Allow popups for this site or open the app in a new tab.',
    };
  }
  if (rawCode === 'auth/popup-closed-by-user' || rawMsg.includes('auth/popup-closed-by-user')) {
    return {
      code: 'auth/popup-closed-by-user',
      isPopupBlocked: false,
      message: 'Google Sign-In popup was closed before completing sign-in.',
    };
  }
  if (
    rawCode === 'auth/cancelled-popup-request' ||
    rawMsg.includes('auth/cancelled-popup-request')
  ) {
    return {
      code: 'auth/cancelled-popup-request',
      isPopupBlocked: false,
      message: 'A sign-in popup is already open. Complete or close it and try again.',
    };
  }
  if (rawCode === 'auth/unauthorized-domain' || rawMsg.includes('auth/unauthorized-domain')) {
    return {
      code: 'auth/unauthorized-domain',
      isPopupBlocked: false,
      message: `Current domain (${typeof window !== 'undefined' ? window.location.hostname : ''}) is not in Firebase Authorized Domains.`,
    };
  }
  return {
    code: rawCode || 'auth/unknown',
    isPopupBlocked: false,
    message: rawMsg,
  };
}

export function isRunningInIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

export async function signInWithGoogleForSocial(): Promise<User> {
  const provider = buildGoogleAuthProvider();
  // Invoke signInWithPopup immediately inside the click stack frame before any awaits
  const cred = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  await ensureUserProfileDoc(cred.user);
  return cred.user;
}

export async function signInWithGooglePopupForDesktopBridge(): Promise<{
  idToken: string;
  accessToken: string;
  email: string;
}> {
  const provider = buildGoogleAuthProvider();
  const result = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  const oauthCred = GoogleAuthProvider.credentialFromResult(result);
  await ensureUserProfileDoc(result.user);
  return {
    idToken: oauthCred?.idToken || '',
    accessToken: oauthCred?.accessToken || '',
    email: result.user.email || result.user.displayName || '',
  };
}

export async function signInWithGoogleCredentialTokens(
  idToken: string,
  accessToken?: string
): Promise<User> {
  const trimmedId = idToken.trim();
  const trimmedAccess = (accessToken || '').trim();
  if (!trimmedId && !trimmedAccess) {
    throw new Error('Missing Google OAuth idToken or accessToken for desktop sign-in.');
  }
  const credential = GoogleAuthProvider.credential(
    trimmedId || null,
    trimmedAccess || null
  );
  const result = await signInWithCredential(auth, credential);
  await ensureUserProfileDoc(result.user);
  return result.user;
}

export async function signInWithGoogleRedirect(): Promise<void> {
  const provider = buildGoogleAuthProvider();
  await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
}

export async function completeGoogleRedirectIfPresent(): Promise<User | null> {
  const cred = await getRedirectResult(auth, browserPopupRedirectResolver);
  if (cred?.user) {
    await ensureUserProfileDoc(cred.user);
    return cred.user;
  }
  return null;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

function mapConnectionDoc(
  raw: Record<string, unknown>,
  fallbackPlatform: SocialPlatformId
): SocialConnectionRecord {
  const rawUpdated = raw.updatedAt as Timestamp | { toDate?: () => Date } | string | undefined;
  let updatedAtIso: string | null = null;
  if (rawUpdated && typeof rawUpdated === 'object' && typeof rawUpdated.toDate === 'function') {
    updatedAtIso = rawUpdated.toDate().toISOString();
  } else if (typeof rawUpdated === 'string') {
    updatedAtIso = rawUpdated;
  }

  return {
    platform: (raw.platform as SocialPlatformId) || fallbackPlatform,
    accountName: String(raw.accountName || ''),
    handle: String(raw.handle || ''),
    externalAccountId: String(raw.externalAccountId || ''),
    accessToken: String(raw.accessToken || ''),
    refreshToken: String(raw.refreshToken || ''),
    expiresAt: Number(raw.expiresAt || 0),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map((s) => String(s)) : [],
    updatedAtIso,
  };
}

export function subscribeSocialConnections(
  userId: string,
  onData: (connections: Record<SocialPlatformId, SocialConnectionRecord | null>) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const colPath = `users/${userId}/socialConnections`;
  return onSnapshot(
    collection(db, 'users', userId, 'socialConnections'),
    (snapshot) => {
      const next: Record<SocialPlatformId, SocialConnectionRecord | null> = {
        tiktok: null,
        instagram: null,
        youtube: null,
      };
      for (const docSnap of snapshot.docs) {
        const pid = docSnap.id as SocialPlatformId;
        if (pid === 'tiktok' || pid === 'instagram' || pid === 'youtube') {
          next[pid] = mapConnectionDoc(docSnap.data(), pid);
        }
      }
      onData(next);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}

export async function fetchSocialConnectionsOnce(
  userId: string
): Promise<Record<SocialPlatformId, SocialConnectionRecord | null>> {
  const colPath = `users/${userId}/socialConnections`;
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'socialConnections'));
    const next: Record<SocialPlatformId, SocialConnectionRecord | null> = {
      tiktok: null,
      instagram: null,
      youtube: null,
    };
    for (const docSnap of snap.docs) {
      const pid = docSnap.id as SocialPlatformId;
      if (pid === 'tiktok' || pid === 'instagram' || pid === 'youtube') {
        next[pid] = mapConnectionDoc(docSnap.data(), pid);
      }
    }
    return next;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, colPath);
  }
}

export async function saveSocialConnection(
  userId: string,
  conn: Omit<SocialConnectionRecord, 'updatedAtIso'>
): Promise<void> {
  const docPath = `users/${userId}/socialConnections/${conn.platform}`;
  try {
    if (auth.currentUser) {
      await ensureUserProfileDoc(auth.currentUser);
    }
    const sanitizedScopes = (conn.scopes || [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 25);

    await setDoc(doc(db, 'users', userId, 'socialConnections', conn.platform), {
      platform: conn.platform,
      accountName: (conn.accountName || conn.platform).slice(0, 160),
      handle: (conn.handle || '').slice(0, 120),
      externalAccountId: (conn.externalAccountId || conn.platform).slice(0, 200),
      accessToken: String(conn.accessToken || '').slice(0, 4096),
      refreshToken: String(conn.refreshToken || '').slice(0, 4096),
      expiresAt: Math.max(0, Number(conn.expiresAt || 0)),
      scopes: sanitizedScopes,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export async function disconnectSocialConnection(
  userId: string,
  platform: SocialPlatformId
): Promise<void> {
  const docPath = `users/${userId}/socialConnections/${platform}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'socialConnections', platform));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}
