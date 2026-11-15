import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  fontScaleFactor,
  normalizeFontScale,
} from "./types.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("t364 font scale settings", () => {
  it("defines three normalized levels with documented factors and px", () => {
    expect(FONT_SCALE_OPTIONS.map((option) => option.id)).toEqual(["small", "standard", "large"]);
    expect(FONT_SCALE_OPTIONS.map((option) => option.factor)).toEqual([0.92, 1, 1.15]);
    expect(fontScaleFactor("small")).toBe(0.92);
    expect(fontScaleFactor("standard")).toBe(1);
    expect(fontScaleFactor("large")).toBe(1.15);
    expect(normalizeFontScale("huge")).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(undefined)).toBe("standard");
  });

  it("defaults, persists and clamps fontScale through Store reopen", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deer-font-scale-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, "deer.db");
    let store = new Store(dbPath);
    expect(store.getLlmSettings().layout?.fontScale).toBe("standard");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: 6, chatHistoryLimit: 40, fontScale: "large" },
    });
    expect(store.getLlmSettings().layout?.fontScale).toBe("large");
    store.close();

    store = new Store(dbPath);
    cleanup.push(() => store.close());
    expect(store.getLlmSettings().layout?.fontScale).toBe("large");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      layout: { maxDockGroups: 6, chatHistoryLimit: 40, fontScale: "huge" as never },
    });
    expect(store.getLlmSettings().layout?.fontScale).toBe("standard");
  });
});
