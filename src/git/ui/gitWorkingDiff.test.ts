import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("t401 working diff CSS contract", () => {
  const css = readFileSync(new URL("./gitWorkingDiff.css", import.meta.url), "utf8");
  const sourceTree = readFileSync(new URL("./gitSourceTree.css", import.meta.url), "utf8");

  it("keeps both file sections independently scrollable with a draggable separator", () => {
    expect(css).toContain(".git-ws-section-list");
    expect(css).toContain("overflow: auto;");
    expect(css).toContain(".git-ws-resizer");
    expect(css).toContain("cursor: row-resize");
    expect(css).toContain(".git-ws-empty");
  });

  it("uses 44/56 workspace and 480 section tabs", () => {
    expect(sourceTree).toContain("grid-template-columns: minmax(0, 44%) minmax(0, 56%)");
    expect(css).toContain(".git-ws-segment-tabs");
    expect(css).toContain("@container git-panel (max-width: 719px)");
    expect(css).toContain(".git-ws-section.mobile-hidden");
  });

  it("styles diff line numbers, add/delete and side-by-side", () => {
    expect(css).toContain(".git-diff-row");
    expect(css).toContain(".diff-add");
    expect(css).toContain(".diff-del");
    expect(css).toContain(".git-diff-side-row");
    expect(css).toContain(".git-diff-hunk-head");
  });
});
