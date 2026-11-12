import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Git Graph responsive contract", () => {
  const css = readFileSync(new URL("./gitGraph.css", import.meta.url), "utf8");

  it("defines 1440 three-column, 960 stacked-detail and 720 tab breakpoints", () => {
    expect(css).toContain("grid-template-columns: minmax(180px, 220px) minmax(320px, 1fr) minmax(300px, 0.9fr)");
    expect(css).toContain("@media (max-width: 960px)");
    expect(css).toContain(".git-graph-detail { grid-column: 1 / -1;");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain(".git-graph-tabs { display: flex; }");
  });

  it("keeps graph content scrollable without page-level horizontal overflow", () => {
    expect(css).toContain("min-width: 0;");
    expect(css).toContain("overflow: auto;");
  });
});
