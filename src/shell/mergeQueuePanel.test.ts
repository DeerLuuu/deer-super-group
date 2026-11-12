import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PANEL_DEFS } from "./dock/panelRegistry";

describe("MergeQueue Dock panel contract", () => {
  it("is a recoverable closed panel without a primary tab", () => {
    const def = PANEL_DEFS.mergeQueue;
    expect(def.title).toBe("合并队列");
    expect(def.routeTab).toBeNull();
    expect(def.closable).toBe(true);
    expect(def.defaultClosed).toBe(true);
  });

  it("has 1440 two-column, 960 single-column and 720 compact CSS", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain(".merge-queue-row {");
    expect(css).toContain("grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr)");
    expect(css).toContain("@media (max-width: 960px)");
    expect(css).toContain(".merge-queue-row { grid-template-columns: minmax(0, 1fr); }");
    expect(css).toContain("@media (max-width: 720px)");
  });

  it("is in the launcher/rail entry list and uses ?merge=1 deep link", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const deeplinkSource = readFileSync(new URL("../shared/deeplink.ts", import.meta.url), "utf8");
    expect(appSource).toContain('"mergeQueue",');
    expect(appSource).toContain('openPanel("mergeQueue")');
    expect(appSource).toContain('if (key === "mergeQueue") setMergeQueueOpen(false)');
    expect(appSource).toContain("onOpenMergeQueue={handleOpenMergeQueue}");
    expect(deeplinkSource).toContain('params.get("merge") === "1"');
  });
});
