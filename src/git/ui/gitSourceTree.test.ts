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

describe("t432 G9：历史/工作区水平分隔条（CSS 契约）", () => {
  const css = readFileSync(new URL("./gitSourceTree.css", import.meta.url), "utf8");

  it("工作区行由 --git-workspace-h 驱动（默认 300），grid 增加 splitter 行", () => {
    expect(css).toContain("grid-template-rows: minmax(180px, 1fr) 30px 6px var(--git-workspace-h, 300px)");
    expect(css).toContain('"nav splitter"');
    expect(css).toMatch(/grid-template-areas:[\s\S]*?"nav history"[\s\S]*?"nav filter"[\s\S]*?"nav splitter"[\s\S]*?"nav workspace"/);
  });

  it("分隔条样式：row-resize、hover/focus 高亮、focus-visible", () => {
    expect(css).toContain(".git-st-splitter");
    expect(css).toContain("grid-area: splitter");
    expect(css).toContain("cursor: row-resize");
    expect(css).toMatch(/\.git-st-splitter:focus-visible\s*\{/);
  });

  it("≤719 三 tab 与 ≤560 短高隐藏分隔条", () => {
    const mobile = css.split("@container git-panel (max-width: 719px)")[1] ?? "";
    expect(mobile).toMatch(/\.git-st-splitter[\s\S]{0,80}display:\s*none/);
    const short = css.split("@container git-panel (max-height: 560px)")[1] ?? "";
    expect(short).toMatch(/\.git-st-history,\s*\.git-st-splitter\s*\{[\s\S]*?display:\s*none/);
  });
});
