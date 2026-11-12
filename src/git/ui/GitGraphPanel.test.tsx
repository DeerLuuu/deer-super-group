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
      expect(html).toContain("只读");
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
      const fileButton = root.findAllByType("button").find((node: any) =>
        node.findAllByType("span").some((span: any) => span.children.some((child: any) => child === "work.txt")),
      );
      expect(fileButton).toBeTruthy();
      await act(async () => {
        fileButton!.props.onClick();
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
});