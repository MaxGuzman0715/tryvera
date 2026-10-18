import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * List pages remember how you left them: filters, search, sort, page and
 * scroll position. Open a record, come back, and the list is exactly where
 * it was, instead of the defaults.
 *
 * sessionStorage, not localStorage: it lasts for this browser tab (through
 * navigation and reloads) but a new tab starts clean, so a filter set days
 * ago never silently hides rows in a fresh session.
 */

const PREFIX = "tryvera:view:";

type Codec<T> = { to: (v: T) => unknown; from: (raw: unknown) => T };

export function usePersistentState<T>(
  key: string,
  initial: T,
  codec?: Codec<T>
): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = PREFIX + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw != null) {
        const parsed = JSON.parse(raw) as unknown;
        return codec ? codec.from(parsed) : (parsed as T);
      }
    } catch {
      /* unreadable or blocked storage: fall back to the default */
    }
    return initial;
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(codec ? codec.to(value) : value));
    } catch {
      /* storage full or blocked: the page still works, it just won't remember */
    }
    // codec is a module-level constant at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, value]);
  return [value, setValue];
}

/** Forget every remembered view, e.g. on sign-out, so the next person starts clean. */
export function clearViewState(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/** For Set<string> state (multi-select filters). */
export const stringSetCodec: Codec<Set<string>> = {
  to: (s) => [...s],
  from: (raw) => new Set(Array.isArray(raw) ? raw.map(String) : []),
};

/**
 * Run `onChange` when `deps` change, but not on mount. For "filters changed →
 * back to page 1": running it on mount would throw away the remembered page.
 * Compares values rather than counting runs, so React StrictMode's double
 * mount in development doesn't fire it either.
 */
export function useOnChange(deps: unknown[], onChange: () => void): void {
  const key = JSON.stringify(deps, (_k, v) => (v instanceof Set ? [...v].sort() : v));
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Put the window back where it was once the list has rendered (`ready`), and
 * keep remembering the position while the page is open. Saved on scroll, not
 * on leaving: by the time a page unmounts, the next page's content may
 * already have clamped the scroll position.
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const storageKey = PREFIX + "scroll:" + key;
  const restored = useRef(false);

  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    let y = 0;
    try {
      y = Number(sessionStorage.getItem(storageKey)) || 0;
    } catch {
      return;
    }
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  }, [ready, storageKey]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!restored.current) return; // don't overwrite the saved spot before restoring it
        try {
          sessionStorage.setItem(storageKey, String(Math.round(window.scrollY)));
        } catch {
          /* ignore */
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [storageKey]);
}
