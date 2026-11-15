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
    expect(html).toContain("搜索 diff");
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

  it("caps side-by-side large diffs at 400 rows and exposes gridcell aria", async () => {
    const text = "const sideValue = 'abcdefghijklmnopqrstuvwxyz0123456789';";
    const lines = Array.from({ length: 20_000 }, (_, index) => ({
      kind: "+" as const,
      text: `${text} // ${index}`,
    }));
    const big: GitDiffPage = {
      bytes: lines.reduce((sum, line) => sum + line.text.length + 2, 0),
      truncated: false,
      binary: false,
      submodule: false,
      files: [
        {
          path: "generated/side.ts",
          status: "M",
          binary: false,
          submodule: false,
          truncated: false,
          hunks: [{ header: "@@ -0,0 +1,20000 @@", lines }],
        },
      ],
    };
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={big} availableWidth={900} />);
    });
    const sideButton = renderer.root
      .findAllByType("button")
      .find((node: any) => String(node.props.children) === "并排");
    expect(sideButton.props.disabled).toBe(false);
    await act(async () => {
      sideButton.props.onClick();
    });
    expect(
      renderer.root.findAll(
        (node: any) =>
          String(node.props.className ?? "").includes("git-diff-side-row"),
      ).length,
    ).toBe(0);
    const hunk = renderer.root
      .findAllByType("button")
      .find((node: any) => node.props["aria-expanded"] === false);
    await act(async () => {
      hunk.props.onClick();
    });
    const sideRows = renderer.root.findAll(
      (node: any) =>
        String(node.props.className ?? "").includes("git-diff-side-row"),
    );
    const cells = renderer.root.findAllByProps({ role: "gridcell" });
    expect(sideRows.length).toBe(400);
    expect(cells.length).toBe(1600);
    expect(String(cells[0]?.props["aria-label"])).toContain("旧行");
    expect(String(cells[1]?.props["aria-label"])).toContain("旧文本");
    expect(String(cells[2]?.props["aria-label"])).toContain("新行");
    expect(String(cells[3]?.props["aria-label"])).toContain("新文本");
    expect(
      renderer.root.findAll((node: any) => typeof node.type === "string").length,
    ).toBeLessThan(10_000);
    renderer.unmount();
  });
});

describe("t360 D1：diff 搜索与加载完整 diff", () => {
  const searchDiff: GitDiffPage = {
    bytes: 200,
    truncated: false,
    binary: false,
    submodule: false,
    files: [
      {
        path: "src/a.ts",
        status: "M",
        binary: false,
        submodule: false,
        truncated: false,
        hunks: [
          {
            header: "@@ -1,3 +1,3 @@",
            lines: [
              { kind: " ", text: "context line" },
              { kind: "-", text: "remove legacy token" },
              { kind: "+", text: "add fresh token" },
            ],
          },
        ],
      },
      {
        path: "src/b.ts",
        status: "M",
        binary: false,
        submodule: false,
        truncated: false,
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            lines: [
              { kind: " ", text: "unrelated" },
              { kind: "+", text: "also unrelated" },
            ],
          },
        ],
      },
    ],
  };

  function findSearchInput(root: any) {
    return root.findByProps({ "aria-label": "搜索 diff 行文本" });
  }

  /** 汇总某节点子树的全部文本（react-test-renderer 会把字符串拆成数组）。 */
  function deepText(node: any): string {
    if (node == null) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(deepText).join("");
    if (node.props && node.props.children !== undefined) return deepText(node.props.children);
    return "";
  }

  function statusCountText(root: any): string {
    const span = root.findAll(
      (node: any) => String(node.props.className ?? "").includes("git-diff-search-count"),
    )[0];
    return span ? deepText(span) : "";
  }

  it("输入即过滤：仅命中文件/行渲染，命中计数与高亮出现", async () => {
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={searchDiff} />);
    });
    const input = findSearchInput(renderer.root);
    expect(input.props.disabled).toBeFalsy();
    await act(async () => {
      input.props.onChange({ target: { value: "token" } });
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("src/a.ts");
    expect(json).not.toContain("src/b.ts");
    expect(json).toContain("diff-hit");
    expect(statusCountText(renderer.root)).toBe("1/2 行 · 2 处");
    renderer.unmount();
  });

  it("无结果态；清空恢复全部文件", async () => {
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={searchDiff} />);
    });
    const input = findSearchInput(renderer.root);
    await act(async () => {
      input.props.onChange({ target: { value: "zzz-not-there" } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("无匹配");
    expect(JSON.stringify(renderer.toJSON())).toContain("没有匹配");
    await act(async () => {
      input.props.onChange({ target: { value: "" } });
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("src/a.ts");
    expect(json).toContain("src/b.ts");
    expect(json).not.toContain("无匹配");
    renderer.unmount();
  });

  it("Enter/Shift+Enter 循环跳转索引", async () => {
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={searchDiff} />);
    });
    const input = findSearchInput(renderer.root);
    await act(async () => {
      input.props.onChange({ target: { value: "token" } });
    });
    expect(statusCountText(renderer.root)).toBe("1/2 行 · 2 处");
    await act(async () => {
      input.props.onKeyDown({ key: "Enter", preventDefault() {} });
    });
    expect(statusCountText(renderer.root)).toBe("2/2 行 · 2 处");
    await act(async () => {
      input.props.onKeyDown({ key: "Enter", shiftKey: true, preventDefault() {} });
    });
    expect(statusCountText(renderer.root)).toBe("1/2 行 · 2 处");
    renderer.unmount();
  });

  it("并排视图搜索过滤旧/新任一侧命中并高亮", async () => {
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={searchDiff} availableWidth={900} />);
    });
    const sideButton = renderer.root
      .findAllByType("button")
      .find((node: any) => String(node.props.children) === "并排");
    await act(async () => {
      sideButton.props.onClick();
    });
    const input = findSearchInput(renderer.root);
    await act(async () => {
      input.props.onChange({ target: { value: "token" } });
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("src/a.ts");
    expect(json).not.toContain("src/b.ts");
    expect(json).toContain("diff-hit");
    renderer.unmount();
  });

  it("截断文件显示「加载完整 diff」两步确认并回调路径", async () => {
    const truncatedDiff: GitDiffPage = {
      ...searchDiff,
      files: [
        {
          ...searchDiff.files[0]!,
          truncated: true,
        },
      ],
    };
    const onLoadFull = vi.fn();
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={truncatedDiff} onLoadFull={onLoadFull} />);
    });
    const armButton = renderer.root
      .findAllByType("button")
      .find((node: any) => String(node.props.children ?? "").includes("加载完整 diff"));
    expect(armButton).toBeTruthy();
    await act(async () => {
      armButton.props.onClick();
    });
    const confirmButton = renderer.root
      .findAllByType("button")
      .find((node: any) => String(node.props.children ?? "").includes("确认加载完整 diff"));
    expect(confirmButton).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain("展示上限 1MB");
    await act(async () => {
      confirmButton.props.onClick();
    });
    expect(onLoadFull).toHaveBeenCalledWith("src/a.ts", null);
    renderer.unmount();
  });

  it("TOO_LARGE 错误态渲染（不卡顿、role=alert）", () => {
    const html = renderToStaticMarkup(
      <GitDiffViewer diff={null} error="GIT_READ_TOO_LARGE: diff exceeds 8MB stdout limit" />,
    );
    expect(html).toContain("TOO_LARGE");
    expect(html).toContain('role="alert"');
  });

  it("20k 行大 diff：搜索后 DOM 收敛到命中行", async () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => ({
      kind: (index % 400 === 0 ? "+" : " ") as "+" | " ",
      text: `line ${index} of the huge file`,
    }));
    const big: GitDiffPage = {
      bytes: 900_000,
      truncated: false,
      binary: false,
      submodule: false,
      files: [
        {
          path: "big.ts",
          status: "M",
          binary: false,
          submodule: false,
          truncated: false,
          hunks: [{ header: "@@ -1 +1 @@", lines }],
        },
      ],
    };
    const { act, create } = TestRenderer as any;
    let renderer: any;
    await act(async () => {
      renderer = create(<GitDiffViewer diff={big} />);
    });
    const input = findSearchInput(renderer.root);
    await act(async () => {
      input.props.onChange({ target: { value: "199" } });
    });
    const rows = renderer.root.findAll((node: any) =>
      String(node.props.className ?? "").includes("git-diff-row"),
    );
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length).toBeLessThan(200);
    expect(JSON.stringify(renderer.toJSON())).toContain("diff-hit");
    renderer.unmount();
  });
});
