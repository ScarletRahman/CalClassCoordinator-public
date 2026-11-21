"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Behaviour every modal surface needs: Escape closes it, Tab stays inside it, focus moves in on
 * open and goes back to whatever opened it on close, and the page behind does not scroll.
 * Attach the returned ref to the dialog's container.
 */
// Dialogs share one browser-history entry so the Back button closes them instead of leaving the app.
let openDialogs = 0;
const HISTORY_KEY = "cccDialog";

export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? node;
      first.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A menu or search list inside the dialog handles its own Escape first.
        if (e.defaultPrevented) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    openDialogs++;
    try {
      if (!window.history.state?.[HISTORY_KEY]) window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, "");
    } catch {
      /* history unavailable (sandboxed frame) */
    }
    const onPop = () => closeRef.current();
    window.addEventListener("popstate", onPop);
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      openDialogs--;
      // Closed some other way than Back: drop our history entry, unless another dialog took over
      // (also covers React re-running this effect in development).
      setTimeout(() => {
        if (openDialogs === 0 && window.history.state?.[HISTORY_KEY]) window.history.back();
      }, 0);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
