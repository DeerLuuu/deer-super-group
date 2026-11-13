import type { Workspace } from "./types.js";

/** Stable localStorage keys for persisted UI layout. No format migration. */
export const LAYOUT_KEYS = {
  sidebarWidth: "deer.sidebarWidth",
  sidebarCollapsed: "deer.sidebarCollapsed",
  taskListWidth: "deer.taskListWidth",
  taskListCollapsed: "deer.taskListCollapsed",
  lastWorkspaceId: "deer.lastWorkspaceId",
  dockPrefix: "deer.dock.v1.",
  gitWorkspaceHeightPrefix: "deer.git.workspaceHeight.",
} as const;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLastWorkspaceId(storage: StorageLike | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(LAYOUT_KEYS.lastWorkspaceId)?.trim() ?? "";
    return value.length > 0 && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastWorkspaceId(
  workspaceId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  const value = workspaceId.trim();
  if (!storage || !value) return;
  try {
    storage.setItem(LAYOUT_KEYS.lastWorkspaceId, value);
  } catch {
    // localStorage unavailable: layout still works for this session.
  }
}

export function forgetLastWorkspaceId(storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(LAYOUT_KEYS.lastWorkspaceId);
  } catch {
    // ignore
  }
}

/**
 * Choose the saved workspace only if it still exists in the workspace list.
 * Otherwise use the first workspace and mark the saved id stale so the caller
 * can remove it. An empty list yields no selection.
 */
export function chooseLastWorkspace(
  workspaces: readonly Pick<Workspace, "id">[],
  savedId: string | null,
): { id: string | null; stale: boolean } {
  if (workspaces.length === 0) return { id: null, stale: savedId !== null };
  const saved = savedId && workspaces.some((workspace) => workspace.id === savedId);
  if (saved) return { id: savedId, stale: false };
  return { id: workspaces[0].id, stale: savedId !== null };
}
