"use client";

import Link from "next/link";
import { useEffect, useId, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { PASSWORD_MIN, request } from "@/lib/useAccount";

export default function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ids = useId();

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    window.history.replaceState(null, "", "/reset");
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (password.length < PASSWORD_MIN) return setError(`Password must be at least ${PASSWORD_MIN} characters.`);
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      await request("/api/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
        <h1 className="mt-2 text-base font-semibold text-slate-900">Password updated</h1>
        <p className="mt-1 text-sm text-slate-600">You&apos;ve been signed out everywhere. Sign in with your new password.</p>
        <Link href="/" className="mt-5 inline-flex min-h-10 items-center rounded-xl bg-cal-blue px-4 py-2 text-sm font-medium text-white hover:bg-[#001a52]">
          Go to sign in
        </Link>
      </div>
    );
  }

  if (token === "") {
    return (
      <p className="text-sm text-slate-600" role="alert">
        This link is missing its code. Open the link from your email again, or ask for a new one from &ldquo;Forgot password?&rdquo; in the sign-in box.
      </p>
    );
  }

  const input =
    "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 sm:text-sm focus:border-[#002676] focus:outline-none focus:ring-2 focus:ring-[#002676]/20";
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <h1 className="text-base font-semibold text-slate-900">Choose a new password</h1>
      <div>
        <label htmlFor={`${ids}-pw`} className="mb-1 block text-xs font-medium text-slate-600">
          New password
        </label>
        <input id={`${ids}-pw`} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        <p className={`mt-1 text-xs ${password && password.length < PASSWORD_MIN ? "text-amber-700" : "text-slate-600"}`}>
          At least {PASSWORD_MIN} characters{password && password.length < PASSWORD_MIN ? ` (${password.length} so far)` : ""}.
        </p>
      </div>
      <div>
        <label htmlFor={`${ids}-pw2`} className="mb-1 block text-xs font-medium text-slate-600">
          Type it again
        </label>
        <input id={`${ids}-pw2`} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          {/invalid, expired|already used/.test(error) && (
            <> Ask for a new one from &ldquo;Forgot password?&rdquo; in the <Link href="/" className="font-medium underline">sign-in box</Link>.</>
          )}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || token === null || !password || !confirm}
        className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#002676] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#001a52] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
