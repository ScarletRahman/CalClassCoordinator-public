"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Bell, Cloud, Download, Eye, EyeOff, KeyRound, Loader2, LogIn, LogOut, MailWarning, Shield, Trash2, X } from "lucide-react";
import {
  OPEN_SIGN_IN_EVENT,
  PASSWORD_MIN,
  changePassword,
  forgotPassword,
  listAlerts,
  removeAlert,
  resendVerification,
  useAccount,
  type SeatAlert,
} from "@/lib/useAccount";
import { usePlanner } from "@/lib/store";
import { useDialog } from "@/lib/useDialog";

type Tab = "login" | "signup" | "forgot";
type VerifyNote = "sent" | "failed" | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const focusRing = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676] focus-visible:ring-offset-1";

export default function AccountMenu({ onSignedIn, onSignedOut }: { onSignedIn?: () => void; onSignedOut?: () => void }) {
  const { user, loading, login, signup, logout, deleteAccount } = useAccount();
  const planner = usePlanner();
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [verifyNote, setVerifyNote] = useState<VerifyNote>(null);

  useEffect(() => {
    const open = () => setModalOpen(true);
    window.addEventListener(OPEN_SIGN_IN_EVENT, open);
    return () => window.removeEventListener(OPEN_SIGN_IN_EVENT, open);
  }, []);

  // The server ended the session (signed out elsewhere): stop syncing, keep what is on screen.
  useEffect(() => {
    if (!loading && !user && planner.sync !== "local") planner.disconnectAccount({ keepLocal: true });
  }, [loading, user, planner]);

  if (loading) {
    return <div className="h-10 w-10 animate-pulse rounded-full bg-slate-200" aria-hidden />;
  }

  if (!user) {
    // Sign-in requests from elsewhere on the page are ignored once signed in.
    return (
      <>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#002676] px-3.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#001a52] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FDB515] focus-visible:ring-offset-2"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          Sign in
        </button>
        {modalOpen && (
          <AuthModal
            onClose={() => setModalOpen(false)}
            onSubmit={async (tab, email, pw) => {
              if (tab === "login") {
                await login(email, pw);
              } else if (tab === "signup") {
                const r = await signup(email, pw);
                setVerifyNote(r.emailSent ? "sent" : "failed");
                setMenuOpen(true); // show where the email stands, honestly
              } else return;
              setModalOpen(false);
              onSignedIn?.();
            }}
          />
        )}
      </>
    );
  }

  return (
    <UserMenu
      email={user.email}
      emailVerified={user.emailVerified}
      verifyNote={verifyNote}
      setVerifyNote={setVerifyNote}
      open={menuOpen}
      setOpen={setMenuOpen}
      sync={planner.sync}
      retrySave={planner.retrySave}
      onSignOut={async (keepLocal) => {
        await logout();
        planner.disconnectAccount({ keepLocal });
        setVerifyNote(null);
        onSignedOut?.();
      }}
      flushSave={planner.flushSave}
      onDelete={async (keepLocal) => {
        await deleteAccount();
        planner.disconnectAccount({ keepLocal });
        setVerifyNote(null);
        onSignedOut?.();
      }}
    />
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  describedBy,
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  describedBy?: string;
  className: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        name="password"
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        className={`${className} pr-11`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className={`absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-slate-400 hover:text-slate-700 ${focusRing}`}
      >
        {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}

function AuthModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (tab: Tab, email: string, password: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(() => {
    if (!busyRef.current) onClose();
  });
  const emailRef = useRef<HTMLInputElement>(null);
  const firstTab = useRef(true);
  const ids = useId();
  const titleId = `${ids}-title`;
  const errId = `${ids}-err`;
  const hintId = `${ids}-hint`;

  useEffect(() => {
    // useDialog focuses the email field on open; afterwards keep focus there when switching tabs.
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    emailRef.current?.focus();
  }, [tab]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError(null);
    setNotice(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    setError(null);
    setNotice(null);
    const addr = email.trim();
    if (!EMAIL_RE.test(addr)) {
      setError("Enter a valid email address, like oski@berkeley.edu.");
      emailRef.current?.focus();
      return;
    }
    if (tab === "signup" && password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters. It has ${password.length}.`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (tab === "forgot") setNotice(await forgotPassword(addr));
      else await onSubmit(tab, addr, password);
    } catch (err) {
      const status = (err as { status?: number }).status;
      let msg = err instanceof Error ? err.message : "Something went wrong.";
      if (tab === "signup" && status === 409) msg = "That email already has an account. Sign in or reset the password.";
      setError(msg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => switchTab(t)}
      className={`min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition ${focusRing} ${
        tab === t ? "bg-white text-[#002676] shadow-sm" : "text-slate-600 hover:text-slate-800"
      }`}
    >
      {label}
    </button>
  );

  const input =
    "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-[#002676] focus:outline-none focus:ring-2 focus:ring-[#002676]/20 sm:text-sm";
  const short = tab === "signup" && password.length > 0 && password.length < PASSWORD_MIN;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/40 p-4 backdrop-blur-[2px] sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-5 text-slate-800 shadow-xl focus:outline-none"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {tab === "login" ? "Sign in" : tab === "signup" ? "Create account" : "Reset password"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`-mr-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 ${focusRing}`}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {tab !== "forgot" && (
          <div role="tablist" aria-label="Account" className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1">
            {tabBtn("login", "Sign in")}
            {tabBtn("signup", "Create account")}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3" noValidate aria-busy={busy}>
          <div>
            <label htmlFor={`${ids}-email`} className="mb-1 block text-xs font-medium text-slate-600">
              Email
            </label>
            <input
              ref={emailRef}
              id={`${ids}-email`}
              name="email"
              type="email"
              inputMode="email"
              autoComplete={tab === "signup" ? "email" : "username"}
              autoCapitalize="none"
              spellCheck={false}
              required
              data-autofocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? errId : undefined}
              className={input}
              placeholder="oski@berkeley.edu"
            />
          </div>
          {tab === "forgot" ? (
            <p className="text-xs text-slate-600">The link expires in one hour.</p>
          ) : (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor={`${ids}-pw`} className="block text-xs font-medium text-slate-600">
                  Password
                </label>
                {tab === "login" && (
                  <button
                    type="button"
                    onClick={() => switchTab("forgot")}
                    className="-my-2 rounded px-1 py-2 text-xs font-medium text-[#002676] hover:underline focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-[#002676]"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <PasswordInput
                id={`${ids}-pw`}
                value={password}
                onChange={setPassword}
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                describedBy={[tab === "signup" ? hintId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined}
                className={input}
              />
              {tab === "signup" && (
                <p id={hintId} className={`mt-1 text-xs ${short ? "text-amber-700" : "text-slate-600"}`}>
                  At least {PASSWORD_MIN} characters{short ? ` (${password.length} so far)` : ""}.
                </p>
              )}
            </div>
          )}

          {error && (
            <p id={errId} role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !email || (tab !== "forgot" && !password)}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#002676] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#001a52] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FDB515] focus-visible:ring-offset-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {tab === "login"
              ? busy
                ? "Signing in…"
                : "Sign in"
              : tab === "signup"
                ? busy
                  ? "Creating account…"
                  : "Create account"
                : busy
                  ? "Sending…"
                  : "Email me a reset link"}
          </button>
          {tab === "forgot" && (
            <button
              type="button"
              onClick={() => switchTab("login")}
              className={`min-h-10 w-full rounded-lg text-center text-sm text-slate-600 hover:text-slate-900 ${focusRing}`}
            >
              Back to sign in
            </button>
          )}
        </form>

        <p className="mt-4 flex items-start gap-2 text-xs text-slate-600">
          <Cloud className="mt-px h-3.5 w-3.5 shrink-0 text-[#b07d00]" aria-hidden />
          <span>
            Sync your plan across devices.{" "}
            <a href="/privacy" className="underline hover:text-slate-800">
              Privacy
            </a>
          </span>
        </p>
      </div>
    </div>
  );
}

type View = "main" | "delete" | "password" | "signout";

const itemCls =
  "flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:opacity-60";
const smallBtn = `flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${focusRing} disabled:opacity-60`;

function UserMenu({
  email,
  emailVerified,
  verifyNote,
  setVerifyNote,
  open,
  setOpen,
  sync,
  retrySave,
  flushSave,
  onSignOut,
  onDelete,
}: {
  email: string;
  emailVerified: boolean;
  verifyNote: VerifyNote;
  setVerifyNote: (v: VerifyNote) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  sync: "local" | "saving" | "saved" | "error";
  retrySave: () => Promise<boolean>;
  flushSave: () => Promise<boolean>;
  onSignOut: (keepLocal: boolean) => Promise<void>;
  onDelete: (keepLocal: boolean) => Promise<void>;
}) {
  const [view, setView] = useState<View>("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SeatAlert[] | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [wipeLocal, setWipeLocal] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const saveFailed = sync === "error";

  useEffect(() => {
    if (!open) {
      setView("main");
      setError(null);
      setNotice(null);
      setUnsaved(false);
      return;
    }
    firstItemRef.current?.focus();
    listAlerts()
      .then((r) => setAlerts(r.alerts))
      .catch(() => setAlerts(null));
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, setOpen]);

  async function run(fn: () => Promise<void>, close = true) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (close) setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  /** Signs out after making sure the account has the latest plan; never drops unsaved work silently. */
  const signOut = (keepLocal: boolean) =>
    run(async () => {
      const ok = await flushSave();
      if (!ok && !keepLocal) {
        setUnsaved(true);
        throw new Error("Couldn't save your latest changes, so the plan was kept on this device.");
      }
      await onSignOut(keepLocal);
    });

  const resend = () =>
    run(async () => {
      try {
        const r = await resendVerification();
        setVerifyNote("sent");
        setNotice(r.alreadyVerified ? "Email already verified. Reload to update." : "Sent. Check your inbox and spam.");
      } catch (e) {
        if ((e as { status?: number }).status === 503) setVerifyNote("failed");
        throw e;
      }
    }, false);

  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const status = saveFailed ? " (could not save your plan)" : emailVerified ? "" : " (email not verified)";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${email}${status}`}
        title={email}
        className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[#002676] text-sm font-semibold text-[#FDB515] ring-2 ring-white shadow-sm transition hover:bg-[#001a52] focus:outline-none focus-visible:ring-[#FDB515]"
      >
        {initial}
        {saveFailed ? (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[10px] font-bold leading-none text-white ring-2 ring-white" aria-hidden>
            !
          </span>
        ) : (
          !emailVerified && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[#FDB515] ring-2 ring-white" aria-hidden />
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 max-h-[calc(100dvh-5rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-1.5 text-slate-700 shadow-lg"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="text-xs text-slate-600">Signed in as</p>
            <p className="break-all text-sm font-medium text-slate-900">{email}</p>
            {saveFailed && (
              <div role="alert" className="mt-2 flex items-center gap-2 rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="flex-1">Couldn&apos;t save. Changes are kept on this device.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (!(await retrySave())) throw new Error("Still couldn't save. Check your connection.");
                      setNotice("Saved to your account.");
                    }, false)
                  }
                  className={`min-h-8 shrink-0 rounded-md bg-white px-2 font-medium text-rose-800 ring-1 ring-rose-300 hover:bg-rose-100 ${focusRing}`}
                >
                  Retry
                </button>
              </div>
            )}
            {!emailVerified && (
              <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                <p className="flex items-start gap-1.5">
                  <MailWarning className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {verifyNote === "failed"
                      ? "Couldn't send the verification email. Try again later."
                      : verifyNote === "sent"
                        ? "Verification link sent. Open it to use seat alerts."
                        : "Verify your email to use seat alerts."}
                  </span>
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={resend}
                  className={`mt-1 min-h-8 rounded font-medium text-[#002676] hover:underline disabled:opacity-60 ${focusRing}`}
                >
                  {verifyNote === "failed" ? "Try again" : "Send a new link"}
                </button>
              </div>
            )}
          </div>

          {view === "main" && (
            <div className="pt-1">
              <div className="px-3 py-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                  <Bell className="h-3.5 w-3.5" aria-hidden /> Seat alerts
                </p>
                {alerts === null ? null : alerts.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">None yet.</p>
                ) : (
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                    {alerts.map((a) => (
                      <li key={a.classNumber} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          {a.course || "Class"} <span className="text-slate-500">#{a.classNumber}</span>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Remove seat alert for ${a.course || "class"} ${a.classNumber}`}
                          onClick={() =>
                            run(async () => {
                              await removeAlert(a.classNumber);
                              setAlerts((prev) => prev?.filter((x) => x.classNumber !== a.classNumber) ?? null);
                            }, false)
                          }
                          className={`flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-red-600 disabled:opacity-60 ${focusRing}`}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="my-1 border-t border-slate-100" />
              <button ref={firstItemRef} type="button" disabled={busy} onClick={() => setView("signout")} className={itemCls}>
                <LogOut className="h-4 w-4 text-slate-500" aria-hidden />
                Sign out
              </button>
              <button type="button" disabled={busy} onClick={() => setView("password")} className={itemCls}>
                <KeyRound className="h-4 w-4 text-slate-500" aria-hidden />
                Change password
              </button>
              <a href="/api/account/export" download className={itemCls}>
                <Download className="h-4 w-4 text-slate-500" aria-hidden />
                Download my data
              </a>
              <a href="/privacy" className={itemCls}>
                <Shield className="h-4 w-4 text-slate-500" aria-hidden />
                Privacy
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => setView("delete")}
                className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 focus:bg-red-50 focus:outline-none disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete account &amp; data
              </button>
            </div>
          )}

          {view === "signout" && (
            <div className="space-y-2 px-3 py-2" role="group" aria-labelledby={`${menuId}-so`}>
              <p id={`${menuId}-so`} className="text-sm font-medium text-slate-900">
                Keep a copy of your plan on this device?
              </p>
              {unsaved || saveFailed ? (
                <p className="rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
                  Latest changes aren&apos;t saved to your account yet. Keep a copy here or retry first.
                </p>
              ) : (
                <p className="text-xs text-slate-600">
                  On a shared computer, choose No.
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  autoFocus={!(unsaved || saveFailed)}
                  disabled={busy || unsaved || saveFailed}
                  onClick={() => signOut(false)}
                  className={`${smallBtn} bg-[#002676] font-medium text-white hover:bg-[#001a52]`}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  No, remove it
                </button>
                <button
                  type="button"
                  autoFocus={unsaved || saveFailed}
                  disabled={busy}
                  onClick={() => signOut(true)}
                  className={`${smallBtn} border border-slate-300 hover:bg-slate-50`}
                >
                  Yes, keep a copy
                </button>
              </div>
              <button type="button" disabled={busy} onClick={() => setView("main")} className={`${smallBtn} w-full text-slate-600 hover:bg-slate-50`}>
                Cancel
              </button>
            </div>
          )}

          {view === "password" && (
            <ChangePasswordForm
              busy={busy}
              onCancel={() => setView("main")}
              onSubmit={(current, next) =>
                run(async () => {
                  await changePassword(current, next);
                  setView("main");
                  setNotice("Password changed. Other devices were signed out.");
                }, false)
              }
            />
          )}

          {view === "delete" && (
            <div className="space-y-2 px-3 py-2" role="group" aria-label="Confirm account deletion">
              <p className="text-sm text-slate-700">
                Delete your account, plan and seat alerts? This can&apos;t be undone.
              </p>
              <label className="flex min-h-10 items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={wipeLocal} onChange={(e) => setWipeLocal(e.target.checked)} className="h-4 w-4 accent-red-600" />
                Also remove the plan from this device
              </label>
              <div className="flex gap-2">
                <button type="button" autoFocus disabled={busy} onClick={() => setView("main")} className={`${smallBtn} border border-slate-300 hover:bg-slate-50`}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => onDelete(!wipeLocal))}
                  className={`${smallBtn} bg-red-600 font-medium text-white hover:bg-red-700`}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  Delete
                </button>
              </div>
            </div>
          )}

          {notice && (
            <p role="status" className="mx-1.5 mb-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="mx-1.5 mb-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ChangePasswordForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (current: string, next: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const ids = useId();
  const input =
    "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-base text-slate-900 focus:border-[#002676] focus:outline-none focus:ring-2 focus:ring-[#002676]/20 sm:text-sm";
  const short = next.length > 0 && next.length < PASSWORD_MIN;
  return (
    <form
      className="space-y-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit(current, next);
      }}
    >
      <div>
        <label htmlFor={`${ids}-cur`} className="mb-0.5 block text-xs font-medium text-slate-600">
          Current password
        </label>
        <input id={`${ids}-cur`} name="current-password" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      </div>
      <div>
        <label htmlFor={`${ids}-new`} className="mb-0.5 block text-xs font-medium text-slate-600">
          New password
        </label>
        <input
          id={`${ids}-new`}
          name="new-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby={`${ids}-hint`}
          className={input}
        />
        <p id={`${ids}-hint`} className={`mt-0.5 text-xs ${short ? "text-amber-700" : "text-slate-600"}`}>
          At least {PASSWORD_MIN} characters{short ? ` (${next.length} so far)` : ""}. Signs out other devices.
        </p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className={`${smallBtn} border border-slate-300 hover:bg-slate-50`}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !current || next.length < PASSWORD_MIN}
          className={`${smallBtn} bg-[#002676] font-medium text-white hover:bg-[#001a52]`}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Save
        </button>
      </div>
    </form>
  );
}
