import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../shared/types";
import type { BoardEntry, MemorySnapshot, Memo } from "../memory/types";

vi.mock("../Modal", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

import MemoryWorkbench, { MEMORY_TAB_HELP } from "./MemoryWorkbench.js";

const agent: Agent = {
  id: "a1",
  workspaceId: "w1",
  name: "Ray",
  role: "engineer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: null,
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "2026-11-10T00:00:00.000Z",
};

const entry: BoardEntry = {
  id: "b1",
  workspaceId: "w1",
  board: "frontend",
  author: "user",
  kind: "decision",
  content: "Use panel-level **isolation** for Dock.",
  refs: [],
  confidence: "high",
  pinned: false,
  source: "user",
  sourceRef: null,
  ttlAt: null,
  lastVerifiedAt: null,
  verifiedBy: null,
  evidenceAt: null,
  status: "active",
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  promotedToId: null,
  stale: false,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  contentHash: "hash",
};

const archived: BoardEntry = {
  ...entry,
  id: "b2",
  content: "Archived note",
  status: "archived",
  archivedAt: "2026-11-10T01:00:00.000Z",
  archiveReason: "manual",
};

const memo: Memo = {
  id: "m1",
  workspaceId: "w1",
  agentId: "a1",
  kind: "lesson",
  content: "Alias lesson for Vitest.",
  tags: ["test"],
  confidence: "medium",
  source: "agent",
  sourceRef: "a1",
  sourceTaskId: null,
  sourceRunId: null,
  expiresAt: null,
  status: "active",
  stale: false,
  lastVerifiedAt: null,
  verifiedBy: null,
  promotedToBoardId: null,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  contentHash: "mhash",
};

function snapshot(): MemorySnapshot {
  return {
    workspaceId: "w1",
    entries: [entry, archived],
    domains: [
      {
        id: "d1",
        workspaceId: "w1",
        name: "frontend",
        nameKey: "frontend",
        description: "",
        defaultTtlDays: null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
    ],
    memos: [memo],
    proposals: [],
    summaries: [],
    counts: {
      boardActive: 1,
      boardArchived: 1,
      boardStale: 0,
      boardExpired: 0,
      memosActive: 1,
      memosStale: 0,
      memosExpired: 0,
      summaries: 0,
      proposalsPending: 0,
    },
    ftsAvailable: true,
    degradedReason: null,
    generatedAt: entry.createdAt,
  };
}

function createDeer() {
  return {
    getMemorySnapshot: vi.fn(async () => snapshot()),
    searchMemory: vi.fn(async () => ({
      hits: [
        {
          id: "b1",
          entityType: "board",
          entityId: "b1",
          workspaceId: "w1",
          board: "frontend",
          agentId: null,
          kind: "decision",
          sourceRef: null,
          refs: [],
          title: "Use panel-level isolation",
          snippet: "Dock isolation",
          content: entry.content,
          contentHash: "hash",
          citations: ["board:b1"],
          source: "user",
          confidence: "high",
          pinned: false,
          verified: false,
          stale: false,
          expired: false,
          createdAt: entry.createdAt,
          lastVerifiedAt: null,
          score: 0.9,
          breakdown: {
            relevance: 1,
            rawRank: -1,
            normalization: "minmax",
            confidence: 1,
            freshness: 1,
            typeWeight: 1,
            pinBoost: 0,
            verifiedBoost: 0,
            evidenceBoost: 0,
            penalty: 0,
            score: 0.9,
          },
        },
      ],
      total: 1,
      budget: { maxTokens: 2000, usedTokens: 120, truncated: false, omitted: 0, perLayer: { working: 0, episodic: 0, semantic: 120 } },
      generatedAt: entry.createdAt,
    })),
    setBoardPinned: vi.fn(async () => ({ ok: true, value: entry })),
    setBoardTtl: vi.fn(async () => ({ ok: true, value: { ...entry, ttlAt: "2026-12-10T00:00:00.000Z" } })),
    restoreBoardEntry: vi.fn(async () => ({ ok: true, value: { ...archived, status: "active" } })),
    onEvent: () => () => undefined,
  };
}

let oldWindow: unknown;
let oldDocument: unknown;
const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnv;
});

function installWindow() {
  oldWindow = (globalThis as { window?: unknown }).window;
  oldDocument = (globalThis as { document?: unknown }).document;
  const deer = createDeer();
  (globalThis as { window?: unknown }).window = {
    deer,
    localStorage: { getItem: () => null, setItem: () => undefined },
    setTimeout,
    clearTimeout,
  };
  (globalThis as { document?: unknown }).document = {
    body: { style: {} },
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  return deer;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function buttonByText(root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }, label: string) {
  return root.findAllByType("button").find((button) => textOf(button.props.children).includes(label));
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = oldWindow;
  (globalThis as { document?: unknown }).document = oldDocument;
  vi.restoreAllMocks();
});

describe("MemoryWorkbench", () => {
  it("renders tabs, search and aria-live loading before data arrives", () => {
    const html = renderToStaticMarkup(
      <MemoryWorkbench
        workspaceId="w1"
        agents={[]}
        selectedBoard={null}
        onSelectBoard={() => undefined}
        autoOpenPublish={false}
        onAutoOpenHandled={() => undefined}
        onNotify={() => undefined}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("黑板");
    expect(html).toContain("备忘录");
    expect(html).toContain("归档审批");
    expect(html).toContain("黑板：团队共享的长期记忆");
    expect(MEMORY_TAB_HELP.board.body).toContain("发布事实");
    expect(MEMORY_TAB_HELP.memo.body).toContain("成员");
    expect(MEMORY_TAB_HELP.archive.body).toContain("下线提案");
    expect(html).toContain('aria-label="检索记忆"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="group"');
  });

  it("pins, searches with memo scope agentId, filters memos and restores an archived entry", async () => {
    // @ts-expect-error react-test-renderer 19.x ships without type declarations
    const rtr = (await import("react-test-renderer")) as {
      default: {
        create: (node: React.ReactElement) => {
          root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
          unmount: () => void;
        };
      };
      act: (fn: () => Promise<void> | void) => Promise<void>;
    };
    const deer = installWindow();
    let renderer: { root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }; unmount: () => void } | null = null;
    try {
      await rtr.act(async () => {
        renderer = rtr.default.create(
          <MemoryWorkbench
            workspaceId="w1"
            agents={[agent]}
            selectedBoard={null}
            onSelectBoard={() => undefined}
            autoOpenPublish={false}
            onAutoOpenHandled={() => undefined}
            onNotify={() => undefined}
          />,
        );
        await Promise.resolve();
      });
      const root = renderer!.root;

      const pin = buttonByText(root, "置顶");
      expect(pin).toBeTruthy();
      await rtr.act(async () => {
        (pin!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(deer.setBoardPinned).toHaveBeenCalledWith({ workspaceId: "w1", entryId: "b1", pinned: true });

      const ttl = buttonByText(root, "设置 TTL");
      expect(ttl).toBeTruthy();
      await rtr.act(async () => {
        (ttl!.props.onClick as () => void)();
        await Promise.resolve();
      });
      const ttlInput = root.findAllByType("input").find((input) => input.props["aria-label"] === "TTL 天数");
      expect(ttlInput).toBeTruthy();
      await rtr.act(async () => {
        (ttlInput!.props.onChange as (event: unknown) => void)({ target: { value: "30" } });
        await Promise.resolve();
      });
      const confirm = buttonByText(root, "确认");
      expect(confirm).toBeTruthy();
      await rtr.act(async () => {
        (confirm!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(deer.setBoardTtl).toHaveBeenCalledWith({ workspaceId: "w1", entryId: "b1", ttlDays: 30 });

      const search = root.findAllByType("input").find((input) => input.props["aria-label"] === "检索记忆");
      expect(search).toBeTruthy();
      await rtr.act(async () => {
        (search!.props.onChange as (event: unknown) => void)({ target: { value: "Dock" } });
        await Promise.resolve();
      });
      await rtr.act(async () => {
        (search!.props.onKeyDown as (event: unknown) => void)({ key: "Enter", preventDefault: () => undefined });
        await Promise.resolve();
      });
      expect(deer.searchMemory).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "w1", agentId: "a1", query: "Dock" }),
      );
      expect(textOf(root.findAllByType("button").find((button) => textOf(button.props.children).includes("board:b1"))?.props.children)).toContain("board:b1");
      expect(textOf(root.findAllByType("section").map((section) => section.props.children))).toContain("120/2000");

      const memoTab = buttonByText(root, "备忘录");
      await rtr.act(async () => {
        (memoTab!.props.onClick as () => void)();
        await Promise.resolve();
      });
      const memoSearch = root.findAllByType("input").find((input) => input.props["aria-label"] === "搜索当前成员备忘录");
      expect(memoSearch).toBeTruthy();
      await rtr.act(async () => {
        (memoSearch!.props.onChange as (event: unknown) => void)({ target: { value: "Alias" } });
        await Promise.resolve();
      });
      expect(textOf(root.findAllByType("article").map((article) => article.props.children))).toContain("Alias lesson");

      const archiveTab = buttonByText(root, "归档审批");
      await rtr.act(async () => {
        (archiveTab!.props.onClick as () => void)();
        await Promise.resolve();
      });
      const restore = buttonByText(root, "恢复");
      expect(restore).toBeTruthy();
      await rtr.act(async () => {
        (restore!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(deer.restoreBoardEntry).toHaveBeenCalledWith({ workspaceId: "w1", entryId: "b2" });
    } finally {
      if (renderer) await rtr.act(async () => renderer!.unmount());
    }
  });

  it("shows an alert and retry action when the snapshot fails", async () => {
    // @ts-expect-error react-test-renderer 19.x ships without type declarations
    const rtr = (await import("react-test-renderer")) as {
      default: {
        create: (node: React.ReactElement) => {
          root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
          unmount: () => void;
        };
      };
      act: (fn: () => Promise<void> | void) => Promise<void>;
    };
    const deer = installWindow();
    deer.getMemorySnapshot.mockRejectedValueOnce(new Error("memory down"));
    let renderer: { root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }; unmount: () => void } | null = null;
    try {
      await rtr.act(async () => {
        renderer = rtr.default.create(
          <MemoryWorkbench
            workspaceId="w1"
            agents={[agent]}
            selectedBoard={null}
            onSelectBoard={() => undefined}
            autoOpenPublish={false}
            onAutoOpenHandled={() => undefined}
            onNotify={() => undefined}
          />,
        );
        await Promise.resolve();
      });
      const root = renderer!.root;
      expect(textOf(root.findAllByType("div").map((node) => node.props.children))).toContain("memory down");
      expect(buttonByText(root, "重试")).toBeTruthy();
      expect(root.findAllByType("div").filter((node) => node.props.role === "alert").length).toBeGreaterThan(0);
    } finally {
      if (renderer) await rtr.act(async () => renderer!.unmount());
    }
  });

  it("t341 explains tabs and shows empty-state CTAs", async () => {
    // @ts-expect-error react-test-renderer 19.x ships without type declarations
    const rtr = (await import("react-test-renderer")) as {
      default: {
        create: (node: React.ReactElement) => {
          root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
          unmount: () => void;
        };
      };
      act: (fn: () => Promise<void> | void) => Promise<void>;
    };
    const deer = installWindow();
    const empty = snapshot();
    deer.getMemorySnapshot.mockResolvedValue({
      ...empty,
      entries: [],
      memos: [],
      proposals: [],
      counts: {
        ...empty.counts,
        boardActive: 0,
        boardArchived: 0,
        memosActive: 0,
        proposalsPending: 0,
      },
    });
    let renderer: { root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }; unmount: () => void } | null = null;
    try {
      await rtr.act(async () => {
        renderer = rtr.default.create(
          <MemoryWorkbench
            workspaceId="w1"
            agents={[agent]}
            selectedBoard={null}
            onSelectBoard={() => undefined}
            autoOpenPublish={false}
            onAutoOpenHandled={() => undefined}
            onNotify={() => undefined}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const root = renderer!.root;
      const memoTab = buttonByText(root, "备忘录");
      await rtr.act(async () => {
        (memoTab!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(buttonByText(root, "新建备忘录")).toBeTruthy();
      expect(buttonByText(root, "去黑板发布")).toBeTruthy();
      const archiveTab = buttonByText(root, "归档审批");
      await rtr.act(async () => {
        (archiveTab!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(buttonByText(root, "去黑板查看条目")).toBeTruthy();
      expect(
        root.findAllByType("p").some((node) =>
          textOf(node.props.children).includes("归档审批：让过时记忆退出"),
        ),
      ).toBe(true);
    } finally {
      if (renderer) await rtr.act(async () => renderer!.unmount());
    }
  });
});
