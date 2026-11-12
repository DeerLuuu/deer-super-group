// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitDiffViewer, buildSideBySide } from "./GitDiffViewer.js";
import type { GitDiffPage } from "../readTypes.js";

const diff: GitDiffPage = {
  bytes: 120,
  truncated: false,
  binary: false,
  submodule: false,
  files: [
    {
      path: "src/app.ts",
      status: "M",
      binary: false,
      submodule: false,
      truncated: false,
      hunks: [
        {
          header: "@@ -10,4 +10,4 @@",
          lines: [
            { kind: " ", text: "line ten" },
            { kind: "-", text: "old value" },
            { kind: "+", text: "new value" },
            { kind: " ", text: "line twelve" },
          ],
        },
      ],
    },
  ],
};

describe("t401 GitDiffViewer", () => {
  it("renders file header, line numbers, +/- colors, hunk and search slot", () => {
    const html = renderToStaticMarkup(<GitDiffViewer diff={diff} />);
    expect(html).toContain("src/app.ts");
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).toContain("@@ -10,4 +10,4 @@");
    expect(html).toContain("diff-add");
    expect(html).toContain("diff-del");
    expect(html).toContain("搜索 diff（即将支持）");
    expect(html).toContain("复制路径");
    expect(html).toContain("统一");
    expect(html).toContain("并排");
    expect(html).toContain("换行");
  });

  it("folds long unchanged context blocks and can expand", async () => {
    const longContext: GitDiffPage = {
      ...diff,
      files: [
        {
          ...diff.files[0]!,
          hunks: [
            {
              header: "@@ -1,10 +1,10 @@",
              lines: Array.from({ length: 10 }, (_, index) => ({
                kind: " " as const,
                text: `context ${index}`,
              })),
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<GitDiffViewer diff={longContext} />);
    expect(html).toContain("展开 6 行未变更内容");
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={longContext} />);
    });
    const fold = renderer.root
      .findAllByType("button")
      .find((node: any) => String(node.props["aria-label"]).includes("展开 6 行"));
    expect(fold).toBeTruthy();
    await act(async () => {
      fold.props.onClick();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("context 9");
    expect(text).not.toContain("展开 6 行未变更内容");
    renderer.unmount();
  });

  it("pairs deletions/additions for side-by-side", () => {
    const rows = [
      { kind: "-" as const, text: "before 1", oldLine: 3, newLine: null },
      { kind: "-" as const, text: "before 2", oldLine: 4, newLine: null },
      { kind: "+" as const, text: "after 1", oldLine: null, newLine: 3 },
      { kind: " " as const, text: "same", oldLine: 5, newLine: 4 },
    ];
    expect(buildSideBySide(rows)).toEqual([
      { kind: " ", oldLine: 3, newLine: 3, oldText: "before 1", newText: "after 1" },
      { kind: "-", oldLine: 4, newLine: null, oldText: "before 2", newText: null },
      { kind: " ", oldLine: 5, newLine: 4, oldText: "same", newText: "same" },
    ]);
  });

  it("states binary, truncated, empty and loading clearly", () => {
    expect(
      renderToStaticMarkup(
        <GitDiffViewer diff={{ ...diff, binary: true }} />,
      ),
    ).toContain("二进制文件不显示 diff");
    expect(
      renderToStaticMarkup(
        <GitDiffViewer diff={{ ...diff, truncated: true }} />,
      ),
    ).toContain("diff 已截断");
    expect(
      renderToStaticMarkup(<GitDiffViewer diff={{ ...diff, files: [] }} />),
    ).toContain("没有文本 diff");
    expect(renderToStaticMarkup(<GitDiffViewer diff={null} loading />)).toContain("加载 diff");
    expect(renderToStaticMarkup(<GitDiffViewer diff={null} />)).toContain(
      "选择文件或提交查看 diff",
    );
  });
});
