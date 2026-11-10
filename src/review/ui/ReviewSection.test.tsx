import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewSummary } from "../types.js";
import ReviewSection from "./ReviewSection.js";

const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
});

function summary(): ReviewSummary {
  return {
    target: {
      id: "review1",
      workspaceId: "w1",
      taskId: "t1",
      authorAgentId: "a1",
      requesterId: "user",
      requesterKind: "human",
      provider: "local",
      prNumber: 2,
      prUrl: null,
      baseBranch: "main",
      baseSha: "base",
      headSha: "head123456",
      mergeBaseSha: "merge",
      diffHash: "hash",
      status: "pending",
      requiredApprovals: 1,
      approvalCount: 0,
      blockerCount: 0,
      staleReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      reviewers: [
        {
          id: "r1",
          targetId: "review1",
          reviewerId: "user",
          reviewerKind: "human",
          role: "reviewer",
          status: "requested",
          assignedBy: "user",
          requestedAt: "2026-01-01T00:00:00.000Z",
          decidedAt: null,
          removedAt: null,
          removedReason: null,
        },
      ],
    },
    mode: "required",
    files: [
      {
        targetId: "review1",
        fileIndex: 0,
        path: "src/a.ts",
        oldPath: null,
        changeType: "M",
        isBinary: false,
        isLfs: false,
        additions: 1,
        deletions: 0,
        lineCount: 2,
        truncated: false,
      },
    ],
    decisions: [],
    gate: { ok: false, mode: "required", targetId: "review1", code: "REVIEW_PENDING", reason: "waiting for approval", blockers: 0, approvals: 0, requiredApprovals: 1 },
  };
}

let oldWindow: unknown;
afterEach(() => {
  (globalThis as { window?: unknown }).window = oldWindow;
  vi.restoreAllMocks();
});

describe("ReviewSection", () => {
  it("renders the loading state with accessible live status", () => {
    const html = renderToStaticMarkup(<ReviewSection taskId="t1" />);
    expect(html).toContain('aria-label="行级评审"');
    expect(html).toContain("加载评审");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("loads summary/diff and submits approval", async () => {
    // @ts-expect-error react-test-renderer 19.x has no bundled types
    const rtr = (await import("react-test-renderer")) as {
      default: {
        create: (node: React.ReactElement) => {
          root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
          unmount: () => void;
        };
      };
      act: (fn: () => Promise<void> | void) => Promise<void>;
    };
    const deer = {
      getReviewSummary: vi.fn(async () => summary()),
      getReviewThreads: vi.fn(async () => []),
      getReviewDiff: vi.fn(async () => ({
        targetId: "review1",
        file: summary().files[0],
        lines: [
          { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;", hunk: 1 },
          { kind: "add", oldLine: null, newLine: 2, text: "const b = 2;", hunk: 1 },
        ],
        offset: 0,
        total: 2,
        hasMore: false,
      })),
      createReviewThread: vi.fn(async () => ({})),
      replyReviewThread: vi.fn(async () => ({})),
      resolveReviewThread: vi.fn(async () => ({})),
      reopenReviewThread: vi.fn(async () => ({})),
      removeReviewer: vi.fn(async () => ({})),
      submitReviewDecision: vi.fn(async () => summary().target),
    };
    oldWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { deer };
    let renderer: { root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> }; unmount: () => void } | null = null;
    try {
      await rtr.act(async () => {
        renderer = rtr.default.create(<ReviewSection taskId="t1" />);
        await Promise.resolve();
      });
      const root = renderer!.root;
      expect(root.findAllByType("button").some((button) => String(button.props.children).includes("通过评审"))).toBe(true);
      const approve = root.findAllByType("button").find((button) => String(button.props.children).includes("通过评审"))!;
      await rtr.act(async () => {
        (approve.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(deer.submitReviewDecision).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t1", decision: "approve", headSha: "head123456" }),
      );
      expect(root.findAllByType("div").some((node) => node.props.role === "listitem")).toBe(true);
    } finally {
      if (renderer) await rtr.act(async () => renderer!.unmount());
    }
  });
});
