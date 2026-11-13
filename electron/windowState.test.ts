import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_MIN_HEIGHT,
  DEFAULT_WINDOW_MIN_WIDTH,
  defaultWindowState,
  normalizeWindowState,
  readWindowState,
  writeWindowState,
  type WorkArea,
} from "./windowState.js";

const primary: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
const secondary: WorkArea = { x: 1920, y: 0, width: 1440, height: 900 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deer-window-state-"));
  roots.push(root);
  return path.join(root, "window-state.json");
}

describe("window state persistence", () => {
  it("restores a saved in-bounds window, including secondary displays", () => {
    const result = normalizeWindowState(
      { x: 2000, y: 80, width: 1200, height: 800, maximized: false },
      [primary, secondary],
    );
    expect(result.restored).toBe(true);
    expect(result.state).toEqual({ x: 2000, y: 80, width: 1200, height: 800, maximized: false });
  });

  it("restores maximized state with normal bounds so unmaximize has a safe size", () => {
    const result = normalizeWindowState(
      { x: 100, y: 80, width: 1200, height: 800, maximized: true },
      [primary, secondary],
    );
    expect(result.restored).toBe(true);
    expect(result.state.maximized).toBe(true);
    expect(result.state.width).toBe(1200);
    expect(result.state.height).toBe(800);
  });

  it("falls back to centered default for missing, malformed, small and offscreen values", () => {
    const expected = defaultWindowState([primary]);
    for (const raw of [
      null,
      {},
      { x: "0", y: 0, width: 1200, height: 800, maximized: false },
      { x: 0, y: 0, width: 900, height: 800, maximized: false },
      { x: 0, y: 0, width: 1200, height: 600, maximized: false },
      { x: 5000, y: 5000, width: 1200, height: 800, maximized: false },
      { x: 0, y: -200, width: 1200, height: 800, maximized: false },
    ]) {
      const result = normalizeWindowState(raw, [primary, secondary]);
      expect(result.restored).toBe(false);
      expect(result.state).toEqual(expected);
    }
  });

  it("falls back when the monitor that held the window is disconnected", () => {
    const result = normalizeWindowState(
      { x: 2500, y: 100, width: 1000, height: 800, maximized: false },
      [primary],
    );
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("offscreen");
    expect(result.state).toEqual(defaultWindowState([primary]));
  });

  it("keeps a window that straddles two displays but still has a reachable titlebar", () => {
    const result = normalizeWindowState(
      { x: 1600, y: 100, width: 1000, height: 800, maximized: false },
      [primary, secondary],
    );
    expect(result.restored).toBe(true);
  });

  it("handles no displays without throwing", () => {
    const result = normalizeWindowState(null, []);
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("no-display");
    expect(result.state.width).toBeGreaterThanOrEqual(DEFAULT_WINDOW_MIN_WIDTH);
    expect(result.state.height).toBeGreaterThanOrEqual(DEFAULT_WINDOW_MIN_HEIGHT);
  });

  it("writes and reads a window state file; malformed files read as null", () => {
    const file = tempFile();
    expect(writeWindowState(file, { x: 10, y: 20, width: 1200, height: 800, maximized: false })).toBe(true);
    expect(readWindowState(file)).toMatchObject({ x: 10, y: 20, width: 1200, height: 800 });
    expect(readFileSync(file, "utf8")).toContain('"maximized": false');
    expect(writeWindowState(file, { x: 10, y: 20, width: 1200, height: 800, maximized: false })).toBe(true);
    writeWindowState(path.join(path.dirname(file), "bad.json"), { x: 0, y: 0, width: 1, height: 1, maximized: false });
    expect(readWindowState(path.join(path.dirname(file), "bad.json"))).toMatchObject({ width: 1 });
    const malformed = path.join(path.dirname(file), "malformed.json");
    writeFileSync(malformed, "{not json", "utf8");
    expect(readWindowState(malformed)).toBeNull();
  });
});
