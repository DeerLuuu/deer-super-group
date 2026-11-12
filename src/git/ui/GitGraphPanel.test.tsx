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
      const tablist = root
        .findAllByProps({ role: "tablist" })
        .find((node: any) => node.props["aria-label"] === "版本视图")!;
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
        node.props.className?.includes?.("git-file-open") &&
        String(node.props["aria-label"] ?? "").startsWith("查看 "),
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
    // t389：view 记忆按 workspaceId 存取；此用例用独立 id，避免继承其它用例的「工作区」视图。
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
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws-stale" />);
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

  // t389：repo 探测尚未返回时不能把「未知」误当成 unborn，闪出首提引导。
  it("does not show the first-commit guide while repo status is still loading", async () => {
    const previous = (globalThis as { window?: unknown }).window;
    let resolveRepo!: (value: unknown) => void;
    const pendingRepo = new Promise<unknown>((resolve) => {
      resolveRepo = resolve;
    });
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: () => pendingRepo,
        gitGraph: async () => ({ ok: false }),
        gitRefs: async () => ({ ok: false }),
        gitCommit: async () => ({ ok: false }),
        gitStatus: async () => ({ ok: false }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    let renderer: ReturnType<typeof TestRenderer.create> | null = null;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws-loading-first-commit" />);
        await Promise.resolve();
      });
      const root = renderer!.root;
      const workspaceTab = root
        .findAllByType("button")
        .find((button: { props: { children?: unknown } }) => {
          const children = button.props.children;
          return Array.isArray(children)
            ? children.some((child) => (typeof child === "string" ? child.trim() === "工作区" : false))
            : children === "工作区";
        });
      expect(workspaceTab).toBeTruthy();
      await act(async () => {
        (workspaceTab!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("首次提交");
      resolveRepo({ ok: false });
    } finally {
      renderer?.unmount();
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
    let graphCalls = 0;
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => {
          graphCalls += 1;
          return { ok: true, value: graph };
        },
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
      const graphCallsBeforeStage = graphCalls;
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
      // t389：stage 不改变提交图，不应重载 graph（避免 writeBusy 长时间阻塞后续按钮）。
      expect(graphCalls).toBe(graphCallsBeforeStage);
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
        expect(
          String(form.findAllByProps({ className: "git-ws-staged-count" })[0]?.props.children),
        ).toContain("已暂存");
        expect(
          String(form.findAllByProps({ className: "git-ws-staged-count" })[0]?.props.children),
        ).toContain("文件");
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
      // t389 走查修复：新建分支也必须声明「仅写入模板行、不覆盖现有文件」。
      expect(json()).toContain("不覆盖任何现有文件");
      renderer!.unmount();

      // t389 走查修复：Dock 视口切换重挂后，按 workspaceId 恢复最后的视图 tab。
      let renderer2: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer2 = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      const remounted = JSON.stringify(renderer2!.toJSON());
      expect(remounted).toContain("已暂存");
      expect(remounted).toContain("提交已暂存文件");
      renderer2!.unmount();
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

  it("renders the SourceTree four-region shell with refs, history columns, filters and working groups", async () => {
    const sha = "b".repeat(40);
    const commit = {
      sha,
      shortSha: "bbbbbbbb",
      parents: [],
      authorName: "Mika",
      authorTime: "2026-03-02T10:00:00Z",
      committerTime: "2026-03-02T10:00:00Z",
      subject: "feat: source tree layout",
      refs: ["HEAD -> main", "origin/main"],
      lane: 0,
      color: 1,
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
      ahead: 2,
      behind: 1,
      baseBranch: "main",
      remote: "origin",
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-03-02T10:00:00Z",
    };
    const refs = [
      { name: "main", fullName: "refs/heads/main", kind: "local", sha },
      { name: "v1.0", fullName: "refs/tags/v1.0", kind: "tag", sha },
      { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", sha },
    ];
    const working = {
      repo,
      staged: [{ path: "staged.txt", status: "M", staged: true }],
      unstaged: [{ path: "work.txt", status: "M", staged: false }],
      untracked: [{ path: "new.txt", status: "?", staged: false }],
      conflicts: [],
      submodules: [],
      truncated: false,
    };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({
          ok: true,
          value: {
            repo,
            commits: [commit],
            refs,
            graphVersion: "v1",
            offset: 0,
            limit: 200,
            hasMore: false,
            nextOffset: null,
            totalLoaded: 1,
            truncated: false,
            layout: { laneCount: 1, maxLanes: 16, truncatedLanes: false },
          },
        }),
        gitRefs: async () => ({ ok: true, value: { refs, worktrees: [], truncated: false } }),
        gitCommit: async () => ({ ok: false }),
        gitStatus: async () => ({ ok: true, value: working }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain("仓库导航");
      expect(json).toContain("分支");
      expect(json).toContain("标签");
      expect(json).toContain("远程");
      expect(json).toContain("Stash（暂存）· 待接入");
      expect(json).toContain("未提交的更改 ");
      expect(json).toContain("描述");
      expect(json).toContain("日期");
      expect(json).toContain("作者");
      expect(json).toContain("Author Name");
      expect(json).toContain("筛选");
      expect(json).toContain("已暂存 (");
      expect(json).toContain("未暂存 / 未跟踪 (");
      expect(json).toContain("选择一个提交查看详情");
      expect(json).toContain("版本视图");
      expect(json).toContain("git-ws-sections");
      expect(json).toContain("git-ws-resizer");
      const root = renderer!.root;
      // t432：面板现有两个 role=separator（暂存区分隔 + 历史/工作区分隔），旧断言改按 testid 定位。
      const separator = root.findByProps({ "data-testid": "git-ws-resizer" });
      expect(separator.props["aria-valuenow"]).toBe(38);
      const sections = root.findByProps({ className: "git-ws-sections" });
      expect(sections).toBeTruthy();
      const stagedSection = root.findByProps({ "aria-label": "已暂存文件，共 1 个" });
      expect(stagedSection.findAllByType("li")).toHaveLength(1);
      expect(stagedSection.findAllByProps({ className: "ellipsis" }).length).toBeGreaterThan(0);
      await act(async () => {
        (separator.props.onKeyDown as (event: unknown) => void)({
          key: "ArrowDown",
          preventDefault() {},
        });
        await Promise.resolve();
      });
      expect(root.findByProps({ "data-testid": "git-ws-resizer" }).props["aria-valuenow"]).toBe(43);
      await act(async () => {
        (root.findByProps({ "data-testid": "git-ws-resizer" }).props.onKeyDown as (event: unknown) => void)({
          key: "Home",
          preventDefault() {},
        });
        await Promise.resolve();
      });
      expect(root.findByProps({ "data-testid": "git-ws-resizer" }).props["aria-valuenow"]).toBe(38);
      for (let index = 0; index < 20; index += 1) {
        await act(async () => {
          (root.findByProps({ "data-testid": "git-ws-resizer" }).props.onKeyDown as (event: unknown) => void)({
            key: "ArrowDown",
            preventDefault() {},
          });
          await Promise.resolve();
        });
      }
      expect(root.findByProps({ "data-testid": "git-ws-resizer" }).props["aria-valuenow"]).toBe(80);
      for (let index = 0; index < 20; index += 1) {
        await act(async () => {
          (root.findByProps({ "data-testid": "git-ws-resizer" }).props.onKeyDown as (event: unknown) => void)({
            key: "ArrowUp",
            preventDefault() {},
          });
          await Promise.resolve();
        });
      }
      expect(root.findByProps({ "data-testid": "git-ws-resizer" }).props["aria-valuenow"]).toBe(20);
      await act(async () => {
        (root.findByProps({ "data-testid": "git-ws-resizer" }).props.onKeyDown as (event: unknown) => void)({
          key: "Home",
          preventDefault() {},
        });
        await Promise.resolve();
      });
      expect(root.findByProps({ "data-testid": "git-ws-resizer" }).props["aria-valuenow"]).toBe(38);
      expect(
        root
          .findAllByProps({ role: "tab" })
          .some((node: any) => String(node.props.children).includes("已暂存")),
      ).toBe(true);
      const author = root
        .findAllByType("input")
        .find((input: any) => String(input.props["aria-label"]).includes("Author Name"));
      await act(async () => {
        (author!.props.onChange as (event: unknown) => void)({ target: { value: "Nobody" } });
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("feat: source tree layout");
      await act(async () => {
        (author!.props.onChange as (event: unknown) => void)({ target: { value: "Mika" } });
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("feat: source tree layout");
      const fileSearch = root
        .findAllByType("input")
        .find((input: any) => input.props["aria-label"] === "搜索工作区文件");
      await act(async () => {
        (fileSearch!.props.onChange as (event: unknown) => void)({ target: { value: "staged" } });
        await Promise.resolve();
      });
      const filtered = JSON.stringify(renderer!.toJSON());
      expect(filtered).toContain("staged.txt");
      expect(filtered).not.toContain("work.txt");
      expect(root.findAllByProps({ className: "git-ws-section-list" })).toHaveLength(2);
      await act(async () => {
        (fileSearch!.props.onChange as (event: unknown) => void)({ target: { value: "work" } });
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("没有已暂存文件");
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  it("t398 hides lanes under date sort and navigates only visible filtered commits", async () => {
    const repo = {
      workspaceId: "ws1",
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      headSha: "c".repeat(40),
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      remote: null,
      shallow: false,
      bare: false,
      gitVersion: "2.40.0",
      generatedAt: "2026-04-03T00:00:00Z",
    };
    const makeCommit = (shaChar: string, author: string, subject: string, time: string, parents: string[] = []) => ({
      sha: shaChar.repeat(40),
      shortSha: shaChar.repeat(8),
      parents,
      authorName: author,
      authorTime: time,
      committerTime: time,
      subject,
      refs: [],
      lane: 0,
      color: 0,
      parentLanes: parents.map((sha, index) => ({ sha, lane: index + 1, kind: "merge" as const })),
      openEdges: [],
    });
    const commits = [
      makeCommit("a", "Mika", "feat: merge branch", "2026-04-03T10:00:00Z", ["b".repeat(40), "d".repeat(40)]),
      makeCommit("b", "Ren", "fix: older", "2026-04-02T10:00:00Z"),
      makeCommit("c", "Mika", "docs: newest", "2026-04-04T10:00:00Z"),
    ];
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      deer: {
        gitRepo: async () => ({ ok: true, value: repo }),
        gitGraph: async () => ({
          ok: true,
          value: {
            repo,
            commits,
            refs: [],
            graphVersion: "v1",
            offset: 0,
            limit: 200,
            hasMore: false,
            nextOffset: null,
            totalLoaded: commits.length,
            truncated: false,
            layout: { laneCount: 3, maxLanes: 16, truncatedLanes: false },
          },
        }),
        gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
        gitCommit: async (_ws: string, sha: string) => ({
          ok: true,
          value: {
            node: commits.find((commit) => commit.sha === sha) ?? commits[0],
            body: "",
            changedFiles: [],
            stats: { files: 0, insertions: 0, deletions: 0 },
            diff: { files: [], bytes: 0, truncated: false, binary: false, submodule: false },
          },
        }),
        gitStatus: async () => ({
          ok: true,
          value: {
            repo,
            staged: [],
            unstaged: [],
            untracked: [],
            conflicts: [],
            submodules: [],
            truncated: false,
          },
        }),
        gitDiff: async () => ({ ok: false }),
      },
    };
    try {
      let renderer: ReturnType<typeof TestRenderer.create> | null = null;
      await act(async () => {
        renderer = TestRenderer.create(<GitGraphPanel workspaceId="ws1" />);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const root = renderer!.root;
      const sort = root.findByProps({ "aria-label": "提交排序" });
      await act(async () => {
        (sort.props.onChange as (event: unknown) => void)({ target: { value: "date" } });
        await Promise.resolve();
      });
      const dateJson = JSON.stringify(renderer!.toJSON());
      expect(dateJson).not.toContain("git-st-lanes");
      expect(dateJson).not.toMatch(/L[1-9]/);
      const author = root
        .findAllByType("input")
        .find((input: any) => String(input.props["aria-label"]).includes("Author Name"));
      await act(async () => {
        (author!.props.onChange as (event: unknown) => void)({ target: { value: "Mika" } });
        await Promise.resolve();
      });
      const listbox = root.findByProps({ role: "listbox" });
      const options = () => root.findAllByProps({ role: "option" });
      expect(options()).toHaveLength(2);
      const selectedLabel = () =>
        options().find((option: any) => option.props["aria-selected"])?.props["aria-label"];
      await act(async () => {
        listbox.props.onKeyDown({ key: "Home", preventDefault() {} });
        await Promise.resolve();
      });
      expect(selectedLabel()).toContain("docs: newest");
      await act(async () => {
        listbox.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
        await Promise.resolve();
      });
      expect(selectedLabel()).toContain("feat: merge branch");
      await act(async () => {
        listbox.props.onKeyDown({ key: "End", preventDefault() {} });
        await Promise.resolve();
      });
      expect(selectedLabel()).toContain("feat: merge branch");
      await act(async () => {
        listbox.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
        await Promise.resolve();
      });
      expect(selectedLabel()).toContain("feat: merge branch");

      const search = root
        .findAllByType("input")
        .find((input: any) => input.props["aria-label"] === "搜索描述或提交");
      await act(async () => {
        (author!.props.onChange as (event: unknown) => void)({ target: { value: "" } });
        (search!.props.onChange as (event: unknown) => void)({ target: { value: "older" } });
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("fix: older");
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("feat: merge branch");
      renderer!.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});