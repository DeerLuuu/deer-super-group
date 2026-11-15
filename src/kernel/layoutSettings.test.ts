import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function memoryStore() {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  return store;
}

describe("t208 LayoutSettings persistence", () => {
  it("defaults maxDockGroups to 6 for a fresh store", () => {
    const store = memoryStore();
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(6);
  });

  it("persists 8, clamps 99→8 and 1→2", () => {
    const store = memoryStore();
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: 8 },
    });
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(8);

    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: 99 },
    });
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(8);

    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: 1 },
    });
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(2);
  });

  it("honors a configured value across a store reopen", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-layout-settings-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, "deer.db");
    const first = new Store(dbPath);
    first.saveLlmSettings({ ...first.getLlmSettings(), layout: { maxDockGroups: 7 } });
    first.close();
    const second = new Store(dbPath);
    cleanup.push(() => second.close());
    expect(second.getLlmSettings().layout?.maxDockGroups).toBe(7);
  });

  it("falls back to 6 for non-numeric values and preserves when layout omitted", () => {
    const store = memoryStore();
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: "nope" as unknown as number },
    });
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(6);

    store.saveLlmSettings({ ...store.getLlmSettings(), layout: { maxDockGroups: 7 } });
    const { layout: _layout, ...withoutLayout } = store.getLlmSettings();
    store.saveLlmSettings(withoutLayout);
    expect(store.getLlmSettings().layout?.maxDockGroups).toBe(7);
  });
});
