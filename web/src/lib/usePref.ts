"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A remembered on/off choice for this browser (a collapsed section, an open panel). It starts at
 * `initial` so server and first client render agree, then adopts the saved value. Storage can be
 * blocked; the page works the same, it just does not remember.
 */
export function usePref(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === "1" || saved === "0") setValue(saved === "1");
    } catch {
      /* not remembered */
    }
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* not remembered */
      }
    },
    [key],
  );
  return [value, set];
}
