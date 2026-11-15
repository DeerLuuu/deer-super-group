import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("t448 console wiring", () => {
  it("exposes only human preload APIs and main IPC handlers", () => {
    const main = read("electron/main.ts");
    const preload = read("electron/preload.ts");
    const ipc = read("src/shared/ipc.ts");
    for (const channel of [
      "console:list",
      "console:start",
      "console:stop",
      "console:input",
      "console:clear",
      "console:snapshot",
      "console:cwds",
    ]) {
      expect(main).toContain(`"${channel}"`);
    }
    for (const method of [
      "consoleList",
      "consoleStart",
      "consoleStop",
      "consoleInput",
      "consoleClear",
      "consoleSnapshot",
      "consoleCwds",
      "onConsoleEvent",
    ]) {
      expect(preload).toContain(`${method}:`);
      expect(ipc).toContain(`${method}(`);
    }
    expect(main).toContain("getConsoleManager()");
    expect(main).toContain("consoleManager.closeAll()");
  });

  it("wires Chat badge/popover and the console dock panel", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("BackgroundTasksButton");
    expect(app).toContain("consoleStore={consoleStore}");
    expect(app).toContain("onOpenConsole={handleOpenConsole}");
    expect(app).toContain('openPanel("console")');
    expect(app).toContain('case "console"');
    expect(app).toContain("ConsolePanel");
    expect(read("src/shell/dock/panelRegistry.ts")).toContain('key: "console"');
  });

  it("does not expose a console tool to the agent kernel", () => {
    const tools = read("src/kernel/tools.ts");
    expect(tools.toLowerCase()).not.toContain("console:start");
    expect(tools.toLowerCase()).not.toContain("consolemanager");
  });
});
