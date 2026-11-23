import { describe, expect, it } from "vitest";
import { clearStore, loadStore, saveStore, storageKey, type DockStore } from "./panelRegistry.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    values,
    removed,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => {
      removed.push(key);
      values.delete(key);
    },
  };
}

describe("dock layout persistence", () => {
  it("round-trips Dock layout and active panel per workspace via stable key", () => {
    const previous = globalThis.localStorage;
    const storage = memoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    const store: DockStore = {
      schema: "deer.dock.state",
      version: 1,
      updatedAt: "2026-11-13T00:00:00.000Z",
      variants: {
        wide: { layout: { grid: "saved" }, activePanel: "gitGraph" },
      },
    };
    expect(storageKey("ws-1")).toBe("deer.dock.v1.ws-1");
    expect(saveStore("ws-1", store)).toBe(true);
    expect(loadStore("ws-1")).toEqual(store);
    expect(loadStore("ws-2")).toBeNull();
    clearStore("ws-1");
    expect(storage.values.has("deer.dock.v1.ws-1")).toBe(false);
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  });

  it("drops corrupt/oversized stores and falls back to default", () => {
    const previous = globalThis.localStorage;
    const storage = memoryStorage({
      "deer.dock.v1.bad": "{bad",
      "deer.dock.v1.big": "x".repeat(64 * 1024 + 1),
    });
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    expect(loadStore("bad")).toBeNull();
    expect(loadStore("big")).toBeNull();
    expect(storage.removed).toEqual(["deer.dock.v1.bad", "deer.dock.v1.big"]);
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  });
});
