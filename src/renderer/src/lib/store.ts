import { useEffect, useState, useSyncExternalStore } from "react";
import type { AppState, HistoryEntry } from "@shared/types";

/** The main process owns all state; the renderer mirrors its latest snapshot. */
function mirror<T>(load: () => Promise<T>, subscribe: (set: (value: T) => void) => () => void) {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    value = next;
    for (const listener of listeners) listener();
  };
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    subscribe(set);
    void load().then((loaded) => {
      // A pushed update that beat the first load is newer; keep it.
      if (value === null) set(loaded);
    });
  };
  return {
    use(): T | null {
      return useSyncExternalStore(
        (listener) => {
          start();
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => value,
      );
    },
  };
}

const appState = mirror<AppState>(
  () => window.jiojoin.getState(),
  (set) => window.jiojoin.on("state", set),
);

const history = mirror<HistoryEntry[]>(
  () => window.jiojoin.listHistory(),
  (set) => window.jiojoin.on("history", set),
);

export const useAppState = appState.use;
export const useHistory = history.use;

/** Re-renders once a second while `active`, for call timers. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
