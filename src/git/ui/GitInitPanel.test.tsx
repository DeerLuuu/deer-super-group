// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../Modal.js", () => ({
  default: ({ children }: { children: unknown }) => <div role="dialog">{children as never}</div>,
}));

import GitGraphPanel from "./GitGraphPanel";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repo = {
  workspaceId: "ws1",
  workspacePath: "/tmp/plain",
  root: "/tmp/plain",
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

const emptyGraph = {
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

function mobileProbe(status: string) {
  return {
    workspaceId: "ws1",
    workspacePath: "/tmp/plain",
    root: "/tmp/plain",
    status,
    canInitialize: status === "ready",
    branch: "main" as const,
    gitVersion: "2.40.0",
    reason: status === "ready" ? null : "工作区位于已有 Git 仓库内",
  };
}

function installApi(options: { probe?: () => Promise<any>; init?: () => Promise<any> } = {}) {
  let current = options.probe ?? (async () => mobileProbe("ready"));
  const init = options.init ?? (async () => ({
    ok: true,
    value: { workspaceId: "ws1", workspacePath: "/tmp/plain", root: "/tmp/plain", branch: "main", headSha: null, initialized: true, auditEventId: "evt" },
  }));
  const api = {
    gitInitProbe: async () => current(),
    gitInit: async () => {
      const result = await init();
      if (result.ok) current = async () => mobileProbe("already-repo");
      return result;
    },
    gitRepo: async () => ({ ok: true, value: repo }),
    gitGraph: async () => ({ ok: true, value: emptyGraph }),
    gitRefs: async () => ({ ok: true, value: { refs: [], worktrees: [], truncated: false } }),
    gitCommit: async () => ({ ok: false }),
    gitStatus: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [], conflicts: [], submodules: [], submodulesUnsupported: false, truncated: false } }),
    gitDiff: async () => ({ ok: false }),
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { deer: api };
  return {
    api,
    restore: () => {
      (globalThis as { window?: unknown }).window = previous;
    },
  };
}

describe("t348 GitGraph init entry", () => {
  it("shows one CTA only for probe=ready", async () => {
    const env = installApi({ probe: async () => mobileProbe("nested-repo") });
    try {
      let renderer: any;
      await act(async () => {
        renderer = create(<GitGraphPanel workspaceId="ws1" />);
        await Promise.resolve();
      });
      expect(renderer.root.findAllByProps({ className: "primary git-init-cta" })).toHaveLength(0);
      expect(JSON.stringify(renderer.toJSON())).toContain("工作区位于已有 Git 仓库内");
      act(() => renderer.unmount());
    } finally {
      env.restore();
    }
  });

  it("confirms, initializes, then refreshes into an empty repo", async () => {
    const env = installApi();
    try {
      let renderer: any;
      await act(async () => {
        renderer = create(<GitGraphPanel workspaceId="ws1" />);
        await Promise.resolve();
        await Promise.resolve();
      });
      const cta = renderer.root.findAllByType("button").find((node: any) => node.children.includes("初始化 Git 仓库"));
      expect(cta).toBeTruthy();
      await act(async () => {
        cta!.props.onClick();
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("不会修改现有文件");
      const confirm = renderer.root.findAllByType("button").filter((node: any) => node.children.includes("初始化 Git 仓库")).at(-1);
      await act(async () => {
        confirm!.props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("main 尚无提交");
      expect(JSON.stringify(renderer.toJSON())).toContain("Git 仓库已初始化");
      act(() => renderer.unmount());
    } finally {
      env.restore();
    }
  });

  it("keeps the modal open with an inline retry on failure", async () => {
    const env = installApi({ init: async () => ({ ok: false, errorCode: "GIT_INIT_TIMEOUT", message: "初始化超时", retryable: true }) });
    try {
      let renderer: any;
      await act(async () => {
        renderer = create(<GitGraphPanel workspaceId="ws1" />);
        await Promise.resolve();
        await Promise.resolve();
      });
      const cta = renderer.root.findAllByType("button").find((node: any) => node.children.includes("初始化 Git 仓库"));
      await act(async () => {
        cta!.props.onClick();
        await Promise.resolve();
      });
      const confirm = renderer.root.findAllByType("button").filter((node: any) => node.children.includes("初始化 Git 仓库")).at(-1);
      await act(async () => {
        confirm!.props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      const text = JSON.stringify(renderer.toJSON());
      expect(text).toContain("初始化超时");
      expect(text).toContain("重试初始化");
      expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy();
      act(() => renderer.unmount());
    } finally {
      env.restore();
    }
  });
});
