"use client";

import { useCallback, useEffect, useState } from "react";

export interface AccountUser {
  id: number;
  email: string;
  emailVerified: boolean;
}

export interface SeatAlert {
  classNumber: string;
  course: string;
  term: string | null;
  includeReserved: boolean;
  createdAt: string;
}

/** Fired on window to ask the account menu to open the sign-in dialog (e.g. from the seat alert button). */
export const OPEN_SIGN_IN_EVENT = "ccc:open-sign-in";
export function requestSignIn() {
  window.dispatchEvent(new Event(OPEN_SIGN_IN_EVENT));
}

/** Fired on window when the server says the session is gone (signed out elsewhere, password changed). */
export const SESSION_ENDED_EVENT = "ccc:session-ended";

export const PASSWORD_MIN = 10;

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ??
      (res.status >= 500 ? "Something went wrong on our side. Try again in a minute." : `Request failed (${res.status})`);
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export async function deleteAccount(): Promise<void> {
  await request("/api/account", { method: "DELETE" });
}

export async function fetchMe(): Promise<AccountUser | null> {
  return (await request<{ user: AccountUser | null }>("/api/auth/me")).user;
}

/** Throws (status 503) when the email could not be sent; the error message says so. */
export async function resendVerification(): Promise<{ alreadyVerified?: boolean }> {
  return request("/api/auth/resend-verification", { method: "POST" });
}

export async function forgotPassword(email: string): Promise<string> {
  const r = await request<{ message: string }>("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
  return r.message;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
}

export async function listAlerts(): Promise<{ alerts: SeatAlert[]; watcherConnected: boolean }> {
  return request("/api/alerts");
}

export async function createAlert(a: { classNumber: string; course: string; term?: string; includeReserved: boolean }): Promise<{ delivered: boolean }> {
  return request("/api/alerts", { method: "POST", body: JSON.stringify(a) });
}

export async function removeAlert(classNumber: string): Promise<void> {
  await request("/api/alerts", { method: "DELETE", body: JSON.stringify({ classNumber }) });
}

export function useAccount() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const u = await fetchMe();
      setUser(u);
      return u;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onEnded = () => void refresh();
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [refresh]);

  /** emailSent is false when the verification email could not be sent (the account exists anyway). */
  const signup = useCallback(async (email: string, password: string) => {
    const r = await request<{ user: AccountUser; emailSent?: boolean }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setUser(r.user);
    return { user: r.user, emailSent: r.emailSent !== false };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await request<{ user: AccountUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setUser(r.user);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    await request("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const removeAccount = useCallback(async () => {
    await deleteAccount();
    setUser(null);
  }, []);

  return { user, loading, signup, login, logout, refresh, deleteAccount: removeAccount };
}
