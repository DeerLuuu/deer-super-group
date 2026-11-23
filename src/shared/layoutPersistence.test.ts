import { describe, expect, it } from "vitest";
import {
  LAYOUT_KEYS,
  chooseLastWorkspace,
  forgetLastWorkspaceId,
  readLastWorkspaceId,
  rememberLastWorkspaceId,
  type StorageLike,
} from "./layoutPersistence.js";

function storage(initial: Record<string, string> = {}): StorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("layout persistence keys", () => {
  it("exposes stable, unique keys for all persisted splits and last workspace", () => {
    const keys = Object.values(LAYOUT_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(LAYOUT_KEYS.sidebarWidth).toBe("deer.sidebarWidth");
    expect(LAYOUT_KEYS.sidebarCollapsed).toBe("deer.sidebarCollapsed");
    expect(LAYOUT_KEYS.taskListWidth).toBe("deer.taskListWidth");
    expect(LAYOUT_KEYS.taskListCollapsed).toBe("deer.taskListCollapsed");
    expect(LAYOUT_KEYS.dockPrefix).toBe("deer.dock.v1.");
    expect(LAYOUT_KEYS.gitWorkspaceHeightPrefix).toBe("deer.git.workspaceHeight.");
  });
});

describe("last workspace selection", () => {
  it("restores a saved workspace that still exists", () => {
    expect(chooseLastWorkspace([{ id: "a" }, { id: "b" }], "b")).toEqual({ id: "b", stale: false });
  });

  it("falls back to the first workspace when the saved id is stale", () => {
    expect(chooseLastWorkspace([{ id: "a" }, { id: "b" }], "gone")).toEqual({ id: "a", stale: true });
  });

  it("returns no selection for an empty workspace list", () => {
    expect(chooseLastWorkspace([], "a")).toEqual({ id: null, stale: true });
    expect(chooseLastWorkspace([], null)).toEqual({ id: null, stale: false });
  });

  it("stores, trims and clears the last workspace id safely", () => {
    const store = storage();
    expect(readLastWorkspaceId(store)).toBeNull();
    rememberLastWorkspaceId(" ws-1 ", store);
    expect(store.values.get(LAYOUT_KEYS.lastWorkspaceId)).toBe("ws-1");
    expect(readLastWorkspaceId(store)).toBe("ws-1");
    forgetLastWorkspaceId(store);
    expect(readLastWorkspaceId(store)).toBeNull();
  });

  it("ignores malformed/oversized values and unavailable storage", () => {
    const store = storage({ [LAYOUT_KEYS.lastWorkspaceId]: "x".repeat(201) });
    expect(readLastWorkspaceId(store)).toBeNull();
    expect(readLastWorkspaceId(null)).toBeNull();
    expect(() => rememberLastWorkspaceId("a", null)).not.toThrow();
    expect(() => forgetLastWorkspaceId(null)).not.toThrow();
  });
});
