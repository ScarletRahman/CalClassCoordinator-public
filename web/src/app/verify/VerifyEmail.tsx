"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { request } from "@/lib/useAccount";

/** Reads ?token= and confirms it with a POST (a GET link alone never changes anything). */
export default function VerifyEmail() {
  const [state, setState] = useState<{ kind: "working" | "ok" | "error"; msg?: string }>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    window.history.replaceState(null, "", "/verify");
    if (!token) {
      setState({ kind: "error", msg: "This link is missing its code. Open the link from your email again." });
      return;
    }
    request("/api/auth/verify", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setState({ kind: "ok" }))
      .catch((e: Error) => setState({ kind: "error", msg: e.message }));
  }, []);

  return (
    <div className="text-center">
      {state.kind === "working" && (
        <p className="flex items-center justify-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Confirming your email…
        </p>
      )}
      {state.kind === "ok" && (
        <>
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
          <h1 className="mt-2 text-base font-semibold text-slate-900">Email confirmed</h1>
          <p className="mt-1 text-sm text-slate-600">You can now turn on seat alerts from any class.</p>
        </>
      )}
      {state.kind === "error" && (
        <>
          <XCircle className="mx-auto h-8 w-8 text-rose-500" aria-hidden />
          <h1 className="mt-2 text-base font-semibold text-slate-900">We couldn&apos;t confirm your email</h1>
          <p className="mt-1 text-sm text-slate-600" role="alert">
            {state.msg} You can send a new link from the account menu.
          </p>
        </>
      )}
      <Link href="/" className="mt-5 inline-flex min-h-10 items-center rounded-xl bg-cal-blue px-4 py-2 text-sm font-medium text-white hover:bg-[#001a52]">
        Back to your plan
      </Link>
    </div>
  );
}
