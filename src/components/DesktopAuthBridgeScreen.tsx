import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, LogIn, ShieldCheck } from 'lucide-react';
import {
  classifyFirebaseAuthError,
  signInWithGooglePopupForDesktopBridge,
} from '../lib/firebase';

interface DesktopAuthBridgeScreenProps {
  callbackUrl: string;
  state: string;
}

function isSafeLoopbackCallback(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url.trim());
}

export const DesktopAuthBridgeScreen: React.FC<DesktopAuthBridgeScreenProps> = ({
  callbackUrl,
  state,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenBundle, setTokenBundle] = useState<{
    idToken: string;
    accessToken: string;
    email: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const safeCallback = useMemo(
    () => (isSafeLoopbackCallback(callbackUrl) ? callbackUrl.trim() : ''),
    [callbackUrl]
  );

  const desktopSignInCode = useMemo(() => {
    if (!tokenBundle) return '';
    return JSON.stringify({
      idToken: tokenBundle.idToken,
      accessToken: tokenBundle.accessToken,
    });
  }, [tokenBundle]);

  const handleBrowserGoogleSignIn = async () => {
    const signInPromise = signInWithGooglePopupForDesktopBridge();
    setBusy(true);
    setError(null);
    try {
      const tokens = await signInPromise;
      setTokenBundle(tokens);
      if (safeCallback && state) {
        window.setTimeout(() => {
          formRef.current?.submit();
        }, 80);
      }
    } catch (err: unknown) {
      const info = classifyFirebaseAuthError(err);
      setError(info.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCopyCode = async () => {
    if (!desktopSignInCode) return;
    try {
      await navigator.clipboard?.writeText(desktopSignInCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#111724] border border-slate-800 rounded-lg p-6 space-y-4 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0" />
          <div>
            <h1 className="text-base font-semibold text-white">
              Sign in to Cutline Studio Desktop
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Authenticate in your browser and hand your Firebase session cleanly back to the
              installed app.
            </p>
          </div>
        </div>

        {!tokenBundle ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleBrowserGoogleSignIn}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {busy ? 'Waiting for Google Sign-In...' : 'Continue with Google'}
          </button>
        ) : (
          <div className="space-y-3 bg-[#0B0F17] border border-emerald-500/35 rounded p-3.5 text-xs">
            <div className="font-semibold text-emerald-300">
              Signed in as {tokenBundle.email}
            </div>
            {safeCallback && state ? (
              <p className="text-slate-300">
                Sending session to your Cutline Studio desktop app. If it did not switch
                automatically, click Return below or paste the Desktop Sign-In Code.
              </p>
            ) : (
              <p className="text-slate-300">
                Copy this one-time Desktop Sign-In Code and paste it into Cutline Studio Desktop:
              </p>
            )}

            {safeCallback && state && (
              <form ref={formRef} method="POST" action={safeCallback} className="pt-1">
                <input type="hidden" name="state" value={state} />
                <input type="hidden" name="id_token" value={tokenBundle.idToken} />
                <input type="hidden" name="access_token" value={tokenBundle.accessToken} />
                <input type="hidden" name="email" value={tokenBundle.email} />
                <button
                  type="submit"
                  className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded"
                >
                  Return Session to Desktop App
                </button>
              </form>
            )}

            <div className="pt-2 border-t border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Desktop Sign-In Code (manual fallback)</span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  {copiedCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedCode ? 'Copied' : 'Copy Code'}
                </button>
              </div>
              <textarea
                readOnly
                rows={2}
                value={desktopSignInCode}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full bg-[#111724] border border-slate-800 rounded p-2 font-mono text-[10px] text-slate-300 outline-none resize-none"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded border border-rose-500/40 bg-rose-950/40 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
