import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("t391 SourceTree responsive contract", () => {
  const css = readFileSync(new URL("./gitSourceTree.css", import.meta.url), "utf8");

  it("defines four-region, 960 and 480 container breakpoints", () => {
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("grid-template-columns: 220px minmax(0, 1fr)");
    expect(css).toContain("grid-template-areas:");
    expect(css).toContain("@container git-panel (max-width: 1099px)");
    expect(css).toContain("@container git-panel (max-width: 719px)");
    expect(css).toContain(".git-st-tabs");
  });

  it("keeps a fixed diff inspector and scrollable regions", () => {
    expect(css).toContain("grid-template-columns: minmax(0, 55%) minmax(0, 45%)");
    expect(css).toContain("min-height: 0;");
    expect(css).toContain("overflow: auto;");
    expect(css).toContain(".mobile-view-workspace .git-st-inspector");
  });
});
