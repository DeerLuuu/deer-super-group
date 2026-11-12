import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("t391 SourceTree responsive contract", () => {
  const css = readFileSync(new URL("./gitSourceTree.css", import.meta.url), "utf8");

  it("defines four-region, 960 and 480 container breakpoints", () => {
    expect(css).toContain("container-type: size");
    expect(css).toContain("grid-template-columns: 220px minmax(0, 1fr)");
    expect(css).toContain("grid-template-areas:");
    expect(css).toContain("@container git-panel (max-width: 1099px)");
    expect(css).toContain("@container git-panel (max-width: 719px)");
    expect(css).toContain(".git-st-tabs");
    expect(css).toContain("@container git-panel (max-height: 560px)");
    expect(css).toContain("grid-template-areas:");
    expect(css).toContain('"nav workspace"');
  });

  it("keeps a fixed diff inspector and scrollable regions", () => {
    expect(css).toContain("grid-template-columns: minmax(0, 44%) minmax(0, 56%)");
    expect(css).toContain("min-height: 0;");
    expect(css).toContain("overflow: auto;");
    expect(css).toContain(".mobile-view-workspace .git-st-inspector");
  });

  it("t398 renders table-only layout without fake lanes under non-topology sort", () => {
    expect(css).toContain(".git-st-layout.table-only .git-st-col-lane");
    expect(css).toContain(".git-st-layout.table-only .git-st-history-head");
    expect(css).toContain("grid-template-columns: minmax(160px, 1fr) 132px 150px 76px");
  });
});
