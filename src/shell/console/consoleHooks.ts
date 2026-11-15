import { useCallback, useSyncExternalStore } from "react";
import type { ConsoleSession } from "../../shared/console.js";
import type { ConsoleStore } from "./consoleStore.js";

const noopSubscribe = () => () => {};
const EMPTY_SESSIONS: ConsoleSession[] = [];

export function useConsoleMeta(store: ConsoleStore | null | undefined) {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? (() => null),
    store?.getSnapshot ?? (() => null),
  );
}

export function useConsoleSessions(store: ConsoleStore | null | undefined): ConsoleSession[] {
  const meta = useConsoleMeta(store);
  return meta?.sessions ?? EMPTY_SESSIONS;
}

export function useConsoleSelected(store: ConsoleStore | null | undefined): ConsoleSession | null {
  const meta = useConsoleMeta(store);
  if (!meta) return null;
  return meta.sessions.find((session) => session.id === meta.selectedId) ?? null;
}

export function useConsoleOutput(store: ConsoleStore | null | undefined, sessionId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!store || !sessionId) return () => {};
      return store.subscribeOutput(sessionId, listener);
    },
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => {
    if (!store || !sessionId) return null;
    return store.getOutput(sessionId);
  }, [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
