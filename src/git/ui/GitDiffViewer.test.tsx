// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GitDiffViewer,
  buildSideBySide,
  canUseSideBySide,
  observeDiffWidth,
} from "./GitDiffViewer.js";
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

  it("states submodule and errors and exposes row aria", () => {
    expect(
      renderToStaticMarkup(<GitDiffViewer diff={diff} error="diff 读取失败" />),
    ).toContain("diff 读取失败");
    expect(
      renderToStaticMarkup(
        <GitDiffViewer diff={{ ...diff, submodule: true }} />,
      ),
    ).toContain("子模块变更不展开");
    const html = renderToStaticMarkup(<GitDiffViewer diff={diff} />);
    expect(html).toContain('role="row"');
    expect(html).toContain("旧行 11");
    expect(html).toContain("新行 11");
    expect(html).toContain('tabindex="0"');
  });

  it("moves focus between rows with ArrowUp/ArrowDown", async () => {
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={diff} />);
    });
    const root = renderer.root.findAll(
      (node: any) => node.props.className === "git-diff-viewer",
    )[0];
    const actualRows = renderer.root.findAllByProps({ role: "row" });
    expect(actualRows.length).toBeGreaterThan(0);
    for (const row of actualRows) {
      expect(row.props.tabIndex).toBe(0);
      expect(String(row.props["aria-label"])).toContain("旧行");
    }
    const rows = [
      { classList: { contains: (name: string) => name === "git-diff-row" }, focus: vi.fn() },
      { classList: { contains: (name: string) => name === "git-diff-row" }, focus: vi.fn() },
    ];
    const preventDefault = vi.fn();
    root.props.onKeyDown({
      key: "ArrowDown",
      target: rows[0],
      currentTarget: { querySelectorAll: () => rows },
      preventDefault,
    });
    expect(rows[1].focus).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    renderer.unmount();
  });

  it("copies path and toggles wrap", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const { act, create } = TestRenderer as any;
      let renderer: any;
      await act(async () => {
        renderer = create(<GitDiffViewer diff={diff} />);
      });
      const copy = renderer.root
        .findAllByType("button")
        .find((node: any) => String(node.props["aria-label"]).startsWith("复制路径"));
      await act(async () => {
        copy.props.onClick();
      });
      expect(writeText).toHaveBeenCalledWith("src/app.ts");
      expect(JSON.stringify(renderer.toJSON())).toContain("已复制");
      const wrapButton = renderer.root
        .findAllByType("button")
        .find((node: any) => String(node.props.children) === "换行");
      await act(async () => {
        wrapButton.props.onClick();
      });
      expect(
        renderer.root.findAll(
          (node: any) => String(node.props.className ?? "").includes("is-wrapped"),
        ).length,
      ).toBeGreaterThan(0);
      renderer.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches wide mode through ResizeObserver at the 560px boundary", () => {
    expect(canUseSideBySide(559)).toBe(false);
    expect(canUseSideBySide(560)).toBe(true);
    class FakeObserver {
      static last: FakeObserver | null = null;
      callback: () => void;
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: () => void) {
        this.callback = callback;
        FakeObserver.last = this;
      }
    }
    let width = 400;
    const changes: boolean[] = [];
    const cleanup = observeDiffWidth(
      { getBoundingClientRect: () => ({ width }) as DOMRect },
      (wide) => changes.push(wide),
      FakeObserver as unknown as typeof ResizeObserver,
    );
    expect(changes).toEqual([false]);
    expect(FakeObserver.last?.observe).toHaveBeenCalledTimes(1);
    width = 700;
    FakeObserver.last?.callback();
    expect(changes).toEqual([false, true]);
    cleanup();
    expect(FakeObserver.last?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("renders a 1MB/20k-line diff collapsed within bounded time and nodes", async () => {
    const text = "const generatedValue = 'abcdefghijklmnopqrstuvwxyz0123456789';";
    const lines = Array.from({ length: 20_000 }, (_, index) => ({
      kind: "+" as const,
      text: `${text} // ${index}`,
    }));
    const bytes = lines.reduce((sum, line) => sum + line.text.length + 2, 0);
    const big: GitDiffPage = {
      bytes,
      truncated: false,
      binary: false,
      submodule: false,
      files: [
        {
          path: "generated/huge.ts",
          status: "M",
          binary: false,
          submodule: false,
          truncated: false,
          hunks: [{ header: "@@ -0,0 +1,20000 @@", lines }],
        },
      ],
    };
    expect(bytes).toBeGreaterThan(1024 * 1024);
    const beforeMemory = process.memoryUsage().heapUsed;
    const started = performance.now();
    const html = renderToStaticMarkup(<GitDiffViewer diff={big} />);
    const elapsed = performance.now() - started;
    const memoryDelta = process.memoryUsage().heapUsed - beforeMemory;
    expect(elapsed).toBeLessThan(2000);
    expect(html).toContain("大 diff");
    expect(html).toContain("@@ -0,0 +1,20000 @@");
    expect((html.match(/git-diff-row/g) ?? []).length).toBe(0);
    expect(html.length).toBeLessThan(100_000);
    expect(memoryDelta).toBeLessThan(256 * 1024 * 1024);
    console.info(
      `[t407] 1MB/20k collapsed render=${elapsed.toFixed(1)}ms heapDelta=${(memoryDelta / 1024 / 1024).toFixed(1)}MB html=${html.length}B`,
    );

    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={big} />);
    });
    const hunk = renderer.root
      .findAllByType("button")
      .find((node: any) => node.props["aria-expanded"] === false);
    expect(hunk).toBeTruthy();
    await act(async () => {
      hunk.props.onClick();
    });
    const rows = renderer.root.findAll(
      (node: any) =>
        Array.isArray(node.props.className)
          ? false
          : String(node.props.className ?? "").startsWith("git-diff-row"),
    );
    expect(rows.length).toBeLessThanOrEqual(400);
    renderer.unmount();
  });
});
