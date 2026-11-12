// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer, { act } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GitGraphPanel from "./GitGraphPanel";

describe("GitGraphPanel", () => {
  it("explains when the desktop bridge is unavailable", () => {
    const html = renderToStaticMarkup(<GitGraphPanel workspaceId="ws1" />);
    expect(html).toContain("版本图不可用");
    expect(html).toContain("桌面桥未加载");
  });

  it("renders the read-only graph shell when the bridge exists", () => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: false, errorCode: "GIT_READ_NOT_REPO", message: "not repo" }),
        gitGraph: async () => ({ ok: false }),
        gitRefs: async () => ({ ok: false }),
        gitCommit: async () => ({ ok: false }),
        gitStatus: async () => ({ ok: false }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    try {
      const html = renderToStaticMarkup(<GitGraphPanel workspaceId="ws1" />);
      expect(html).toContain("版本图");
      expect(html).toContain("本地可写");
      expect(html).toContain("筛选提交");
      expect(html).toContain('role="tablist"');
      expect(html).toContain("aria-label=\"版本视图\"");
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  it("shows the working-tree diff after selecting a file", async () => {
    const sha = "a".repeat(40);
    const commit = {
      sha,
      shortSha: "aaaaaaaa",
      parents: [],
      authorName: "Read",
      authorTime: "2026-01-01T00:00:00Z",
      committerTime: "2026-01-01T00:00:00Z",
      subject: "one",
      refs: [],
      lane: 0,
      color: 0,
      parentLanes: [],
      openEdges: [],
    };
    const repo = {
      workspaceId: "ws1",
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      headSha: sha,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      remote: null,
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const graph = {
      repo,
      commits: [commit],
      refs: [],
      graphVersion: "v1",
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      totalLoaded: 1,
      truncated: false,
      layout: { laneCount: 1, maxLanes: 16, truncatedLanes: false },
    };
    const detail = {
      node: commit,
      body: "",
      changedFiles: [{ path: "work.txt", status: "M", staged: false }],
      stats: { files: 1, insertions: 1, deletions: 0 },
      diff: { files: [], bytes: 0, truncated: false, binary: false, submodule: false },
    };
    const working = {
      repo,
      staged: [],
      unstaged: [],
      untracked: [{ path: "work.txt", status: "?", staged: false }],
      conflicts: [],
      submodules: [],
      truncated: false,
    };
    const diff = {
      files: [{ path: "work.txt", status: "M", binary: false, submodule: false, truncated: false, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "+" as const, text: "diff text" }] }] }],
      bytes: 10,
      truncated: false,
      binary: false,
      submodule: false,
    };
    const previous = (globalThis as { window?: unknown }).window;
    let commitCalls = 0;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({ ok: true, value: graph }),
        gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
        gitCommit: async () => {
          commitCalls += 1;
          return { ok: true, value: detail };
        },
        gitStatus: async () => ({ ok: true, value: working }),
        gitDiff: async () => ({ ok: true, value: diff }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        await Promise.resolve();
      });
      const root = renderer!.root;
      const tablist = root.findByProps({ role: "tablist" });
      await act(async () => {
        tablist.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
      });
      expect(root.findByProps({ id: "git-graph-tab-detail" }).props["aria-selected"]).toBe(true);
      expect(root.findByProps({ id: "git-graph-tab-graph" }).props["aria-controls"]).toBe("git-graph-panel-graph");
      expect(root.findByProps({ id: "git-graph-tab-detail" }).props.tabIndex).toBe(0);
      const listbox = root.findByProps({ role: "listbox" });
      expect(root.findByProps({ role: "option" }).props["aria-selected"]).toBe(true);
      await act(async () => {
        listbox.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
      });
      const row = root.findByProps({ role: "option" });
      await act(async () => {
        row.props.onKeyDown({ key: "Enter", preventDefault() {} });
        await Promise.resolve();
      });
      expect(commitCalls).toBe(2);
      await act(async () => {
        root.findByProps({ id: "git-graph-tab-workspace" }).props.onClick();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      const workspaceTab = root.findByProps({ id: "git-graph-tab-workspace" });
      await act(async () => {
        workspaceTab.props.onClick();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      // t352 G1：文件行改为 checkbox 行 + 「diff」按钮。
      const diffButton = root.findAllByType("button").find((node: any) =>
        node.props.className?.includes?.("git-file-open"),
      );
      expect(diffButton).toBeTruthy();
      await act(async () => {
        diffButton!.props.onClick();
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("文件 diff");
      expect(JSON.stringify(renderer!.toJSON())).toContain("diff text");
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  it("ignores a stale loadCommit response after a newer selection", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const makeCommit = (sha: string, subject: string) => ({
      sha,
      shortSha: sha.slice(0, 8),
      parents: [],
      authorName: "Read",
      authorTime: "2026-01-01T00:00:00Z",
      committerTime: "2026-01-01T00:00:00Z",
      subject,
      refs: [],
      lane: 0,
      color: 0,
      parentLanes: [],
      openEdges: [],
    });
    const commitA = makeCommit(shaA, "A");
    const commitB = makeCommit(shaB, "B");
    const repo = {
      workspaceId: "ws1",
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      headSha: shaA,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      remote: null,
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const graph = {
      repo,
      commits: [commitA, commitB],
      refs: [],
      graphVersion: "v1",
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      totalLoaded: 2,
      truncated: false,
      layout: { laneCount: 1, maxLanes: 16, truncatedLanes: false },
    };
    const pending = new Map<string, (value: unknown) => void>();
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({ ok: true, value: graph }),
        gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
        gitCommit: (_workspace: string, sha: string) =>
          new Promise((resolve) => {
            pending.set(sha, resolve);
          }),
        gitStatus: async () => ({ ok: false }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        await Promise.resolve();
      });
      const root = renderer!.root;
      const rows = root.findAllByProps({ role: "option" });
      expect(rows).toHaveLength(2);
      await act(async () => {
        rows[1].props.onClick();
        await Promise.resolve();
      });
      await act(async () => {
        pending.get(shaB)!({ ok: true, value: { node: commitB, body: "", changedFiles: [], stats: { files: 0, insertions: 0, deletions: 0 }, diff: { files: [], bytes: 0, truncated: false, binary: false, submodule: false } } });
        await Promise.resolve();
      });
      await act(async () => {
        pending.get(shaA)!({ ok: true, value: { node: commitA, body: "", changedFiles: [], stats: { files: 0, insertions: 0, deletions: 0 }, diff: { files: [], bytes: 0, truncated: false, binary: false, submodule: false } } });
        await Promise.resolve();
      });
      expect(root.findByType("h2").props.children).toBe("B");
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  // t352 G1：写闭环——勾选暂存、提交框、guard 错误 inline 提示、首次提交引导。
  it("stages selected files, submits commit, and shows guard errors inline", async () => {
    const sha = "c".repeat(40);
    const repo = {
      workspaceId: "ws1",
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      headSha: sha,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      remote: null,
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const commit = {
      sha,
      shortSha: "cccccccc",
      parents: [],
      authorName: "A",
      authorTime: "2026-01-01T00:00:00Z",
      committerTime: "2026-01-01T00:00:00Z",
      subject: "base",
      refs: [],
      lane: 0,
      color: 0,
      parentLanes: [],
      openEdges: [],
    };
    const graph = {
      repo,
      commits: [commit],
      refs: [],
      graphVersion: "v1",
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      totalLoaded: 1,
      truncated: false,
      layout: { laneCount: 1, maxLanes: 16, truncatedLanes: false },
    };
    let working = {
      repo,
      staged: [] as never[],
      unstaged: [] as never[],
      untracked: [
        { path: "a.txt", status: "?", staged: false },
        { path: "b.txt", status: "?", staged: false },
      ] as never[],
      conflicts: [] as never[],
      submodules: [] as never[],
      truncated: false,
    };
    const detail = {
      node: commit,
      body: "",
      changedFiles: [],
      stats: { files: 0, insertions: 0, deletions: 0 },
      diff: { files: [], bytes: 0, truncated: false, binary: false, submodule: false },
    };
    const calls = { stage: [] as string[][], commit: [] as Array<{ title: string; body?: string }>, preview: 0 };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({ ok: true, value: graph }),
        gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
        gitCommit: async () => ({ ok: true, value: detail }),
        gitStatus: async () => ({ ok: true, value: working }),
        gitDiff: async () => ({ ok: false }),
        gitStage: async (_ws: string, paths: string[]) => {
          calls.stage.push(paths);
          working = {
            ...working,
            untracked: working.untracked.filter((file: { path: string }) => !paths.includes(file.path)),
            staged: paths.map((path) => ({ path, status: "A", staged: true })),
          } as typeof working;
          return { ok: true, value: { paths } };
        },
        gitUnstage: async (_ws: string, paths: string[]) => {
          working = {
            ...working,
            staged: working.staged.filter((file: { path: string }) => !paths.includes(file.path)),
            untracked: [...working.untracked, ...paths.map((path) => ({ path, status: "?", staged: false }))],
          } as typeof working;
          return { ok: true, value: { paths } };
        },
        gitCreateCommit: async (_ws: string, title: string, body?: string) => {
          calls.commit.push({ title, body });
          working = { ...working, staged: [] } as typeof working;
          return { ok: true, value: { sha: "d".repeat(40), branch: "main", files: ["a.txt"], title } };
        },
        gitIgnorePreview: async () => {
          calls.preview += 1;
          return {
            ok: true,
            value: { exists: false, existing: "", additions: ["node_modules/", "dist/"], preview: "node_modules/\ndist/\n" },
          };
        },
        gitIgnoreApply: async () => ({ ok: true, value: { addedLines: ["node_modules/"], created: true } }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const root = renderer!.root;
      await act(async () => {
        root.findByProps({ id: "git-graph-tab-workspace" }).props.onClick();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const json = () => JSON.stringify(renderer!.toJSON());

      // 勾选「全选未暂存」→ 暂存选中 → gitStage 收到两个路径。
      await act(async () => {
        const selectAll = root.findByProps({ "aria-label": "全选未暂存文件" });
        selectAll.props.onChange({ target: { checked: true } });
        await Promise.resolve();
      });
      await act(async () => {
        const stageBtn = root.findAllByType("button").find((node: any) => {
          const text = String(node.props.children ?? "");
          return text.includes("暂存选中") && !text.includes("取消");
        });
        expect(stageBtn).toBeTruthy();
        stageBtn!.props.onClick();
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(calls.stage).toEqual([["a.txt", "b.txt"]]);
      expect(json()).toContain("已暂存");

      // 提交框：填标题 → 提交（N 个文件）→ gitCreateCommit 收到标题。
      await act(async () => {
        const titleInput = root.findByProps({ placeholder: "例如：feat: 补齐健康检查接口" });
        titleInput.props.onChange({ target: { value: "feat: write flow" } });
        await Promise.resolve();
      });
      await act(async () => {
        const submit = root.findAllByType("button").find((node: any) => {
          const text = String(node.props.children ?? "");
          return text.includes("提交（") && text.includes("个文件）");
        });
        expect(submit).toBeTruthy();
        // test renderer 不会把 submit 冒泡到 form，直接触发 form onSubmit。
        const form = root.findByProps({ "aria-label": "提交已暂存文件" });
        form.props.onSubmit({ preventDefault() {} });
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(calls.commit).toEqual([{ title: "feat: write flow", body: undefined }]);
      expect(json()).toContain("已提交");

      // .gitignore：预览 Modal 打开并显示将追加的行。
      await act(async () => {
        const ignoreBtn = root.findAllByType("button").find((node: any) =>
          String(node.props.children ?? "").includes("生成 .gitignore"),
        );
        ignoreBtn!.props.onClick();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      expect(calls.preview).toBe(1);
      expect(json()).toContain("生成 .gitignore");
      expect(json()).toContain("node_modules/");
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  it("shows the first-commit guide and disables commit without staged files on an unborn repo", async () => {
    const repo = {
      workspaceId: "ws1",
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      headSha: null,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      remote: null,
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const graph = {
      repo,
      commits: [],
      refs: [],
      graphVersion: "empty",
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      totalLoaded: 0,
      truncated: false,
      layout: { laneCount: 0, maxLanes: 16, truncatedLanes: false },
    };
    const working = {
      repo,
      staged: [],
      unstaged: [],
      untracked: [{ path: "app.ts", status: "?", staged: false }],
      conflicts: [],
      submodules: [],
      truncated: false,
    };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({ ok: true, value: graph }),
        gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
        gitCommit: async () => ({ ok: false }),
        gitStatus: async () => ({ ok: true, value: working }),
        gitDiff: async () => ({ ok: false }),
        gitStage: async (_ws: string, paths: string[]) => ({ ok: true, value: { paths } }),
        gitUnstage: async (_ws: string, paths: string[]) => ({ ok: true, value: { paths } }),
        gitCreateCommit: async () => ({ ok: false }),
        gitIgnorePreview: async () => ({ ok: false }),
        gitIgnoreApply: async () => ({ ok: false }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const root = renderer!.root;
      await act(async () => {
        root.findByProps({ id: "git-graph-tab-workspace" }).props.onClick();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain("首次提交");
      expect(json).toContain("尚无提交"); // graph 空态文案
      const submit = root.findAllByType("button").find((node: any) =>
        String(node.props.children ?? "").includes("提交（0 个文件）"),
      );
      expect(submit?.props.disabled).toBe(true);
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});