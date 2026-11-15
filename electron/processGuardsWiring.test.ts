import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("main process EPIPE guard wiring", () => {
  it("installs the guard at module scope before creating a window/service", () => {
    const install = source.indexOf("installProcessGuards({ logPath: processGuardLogPath })");
    const createWindow = source.indexOf("function createWindow()");
    expect(install).toBeGreaterThan(-1);
    expect(createWindow).toBeGreaterThan(-1);
    expect(install).toBeLessThan(createWindow);
    expect(source).toContain("app.getPath(\"userData\")");
    expect(source).toContain("main-process.log");
  });

  it("does not use console in the guard module", () => {
    const guard = readFileSync(new URL("./processGuards.ts", import.meta.url), "utf8");
    expect(guard).not.toContain("console.error");
    expect(guard).not.toContain("console.warn");
    expect(guard).toContain("appendFileSync");
  });
});
