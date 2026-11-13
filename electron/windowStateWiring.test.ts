import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("main window-state wiring", () => {
  it("wires restore diagnostics and persisted normal bounds", () => {
    expect(source).toContain("readWindowState(stateFile)");
    expect(source).toContain("normalizeWindowState(");
    expect(source).toContain("windowStateDiagnostic(restored.reason)");
    expect(source).toContain("console.warn(diagnostic)");
    expect(source).toContain("windowStateForPersist(normal, win.isMaximized())");
    expect(source).toContain("minWidth: DEFAULT_WINDOW_MIN_WIDTH");
    expect(source).toContain("minHeight: DEFAULT_WINDOW_MIN_HEIGHT");
  });

  it("debounces every layout-changing window event and flushes on close", () => {
    for (const event of ["resize", "move", "maximize", "unmaximize", "minimize"]) {
      expect(source).toContain(`win.on("${event}", schedule)`);
    }
    expect(source).toContain('win.on("close", persist)');
    expect(source).toContain("}, 400);");
  });
});
