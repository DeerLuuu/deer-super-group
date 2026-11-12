import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import PollPanel, { PollResults, formatRemaining, pollStatusLabel, thresholdLabel } from "./PollPanel";
import type { Poll } from "../shared/poll";

vi.mock("../Modal", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

// react-test-renderer 19.x ships without type declarations; dynamic import keeps types local.
// @ts-expect-error react-test-renderer 19.x ships without type declarations
const rtr = (await import("react-test-renderer")) as {
  default: {
    create: (element: unknown) => {
      root: {
        findAllByType: (type: string) => Array<{ props: Record<string, unknown> }>;
        findAll: (predicate: (node: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }>;
      };
      toJSON: () => unknown;
      unmount: () => void;
    };
  };
  act: (fn: () => void | Promise<void>) => Promise<void>;
};

const poll: Poll = {
  id: "p1",
  workspaceId: "w1",
  scope: "team",
  scopeId: null,
  title: "Choose systems",
  description: "",
  mode: "multi",
  maxSelections: 3,
  thresholdRule: "gt",
  thresholdValue: 3,
  quorum: 4,
  allowAbstain: true,
  anonymous: false,
  status: "closed",
  createdBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  closesAt: "2026-01-02T00:00:00.000Z",
  closedAt: "2026-01-02T00:00:00.000Z",
  decisionRef: "b1",
  options: [
    { id: "o1", pollId: "p1", label: "Poll", description: "", sourceType: "manual", sourceId: null, sortOrder: 0 },
    { id: "o2", pollId: "p1", label: "Review", description: "", sourceType: "manual", sourceId: null, sortOrder: 1 },
  ],
  ballots: [],
  result: {
    totalBallots: 5,
    thresholdRule: "gt",
    thresholdValue: 3,
    quorum: 4,
    quorumMet: true,
    insufficientQuorum: false,
    adoptedOptionIds: ["o1"],
    options: [
      { optionId: "o1", label: "Poll", count: 5, percent: 100, adopted: true },
      { optionId: "o2", label: "Review", count: 1, percent: 20, adopted: false },
    ],
  },
  decision: {
    id: "d1",
    pollId: "p1",
    workspaceId: "w1",
    adoptedOptionIds: ["o1"],
    insufficientQuorum: false,
    summary: "Adopted Poll",
    boardEntryId: "b1",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
};

describe("PollPanel helpers", () => {
  it("labels status/threshold and countdown", () => {
    expect(pollStatusLabel("open")).toBe("进行中");
    expect(pollStatusLabel("closed")).toBe("已关闭");
    expect(thresholdLabel("gt", 3)).toContain("3");
    expect(thresholdLabel("percent", 50)).toContain("50%");
    expect(formatRemaining(null, Date.now())).toBe("无截止");
    expect(formatRemaining("2020-01-01T00:00:00.000Z", Date.now())).toBe("已截止");
  });

  it("renders adopted results with accessible progress bars and quorum text", () => {
    const html = renderToStaticMarkup(<PollResults poll={poll} />);
    expect(html).toContain("Poll");
    expect(html).toContain("Review");
    expect(html).toContain("达到投票门槛");
    expect(html).toContain("采纳");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("票数 &gt; 3");
  });

  it("renders insufficient quorum without adopted styling", () => {
    const insufficient: Poll = {
      ...poll,
      status: "closed",
      result: {
        ...poll.result,
        totalBallots: 2,
        quorum: 4,
        quorumMet: false,
        insufficientQuorum: true,
        adoptedOptionIds: [],
        options: poll.result.options.map((option) => ({ ...option, adopted: false })),
      },
      decision: { ...poll.decision!, adoptedOptionIds: [], insufficientQuorum: true, boardEntryId: null, summary: "No quorum" },
    };
    const html = renderToStaticMarkup(<PollResults poll={insufficient} />);
    expect(html).toContain("未达投票门槛");
    expect(html).toContain("不产生采纳项");
    expect(html).not.toContain("已写入黑板");
  });

  it("keeps a narrow-window single-column layout rule for the Poll dock", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const section = css.slice(css.indexOf("t136 Poll"));
    expect(section).toContain("@media (max-width: 900px)");
    expect(section).toContain(".poll-layout { grid-template-columns: minmax(0, 1fr); }");
  });
});

function makeOpenPoll(overrides: Partial<Poll> = {}): Poll {
  return {
    ...poll,
    id: "p1",
    workspaceId: "w1",
    title: "Pick a system",
    description: "Team decision",
    status: "open",
    createdBy: "user",
    closedAt: null,
    decisionRef: null,
    decision: null,
    ballots: [],
    result: {
      ...poll.result,
      totalBallots: 0,
      adoptedOptionIds: [],
      options: poll.result.options.map((option) => ({ ...option, count: 0, percent: 0, adopted: false })),
    },
    ...overrides,
  };
}

function makeClosedPoll(): Poll {
  return {
    ...makeOpenPoll(),
    status: "closed",
    closedAt: "2026-01-02T00:00:00.000Z",
    decisionRef: "b1",
    result: {
      ...poll.result,
      totalBallots: 5,
      adoptedOptionIds: ["o1"],
    },
    decision: {
      id: "d1",
      pollId: "p1",
      workspaceId: "w1",
      adoptedOptionIds: ["o1"],
      insufficientQuorum: false,
      summary: "Approved Poll",
      boardEntryId: "b1",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  };
}

function makeDeer() {
  let current = makeOpenPoll();
  const listPolls = vi.fn(async () => [current]);
  const castPoll = vi.fn(async (_workspaceId: string, input: { selections: string[] }) => {
    current = {
      ...current,
      ballots: [{
        id: "b1",
        pollId: "p1",
        voterId: "user",
        voterType: "human",
        selections: input.selections,
        submittedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: 1,
      }],
      result: {
        ...current.result,
        totalBallots: 1,
        adoptedOptionIds: current.options[0] ? [current.options[0].id] : [],
      },
    };
    return current;
  });
  const closePoll = vi.fn(async () => {
    current = makeClosedPoll();
    return current;
  });
  const createPoll = vi.fn(async (input: { title: string; options: Array<{ label: string }> }) => {
    current = makeOpenPoll({ id: "p2", title: input.title });
    return current;
  });
  return {
    deer: {
      listPolls,
      getPoll: vi.fn(async () => current),
      castPoll,
      closePoll,
      createPoll,
      onEvent: () => () => undefined,
    },
    get current() {
      return current;
    },
  };
}

let oldWindow: unknown;
const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  (globalThis as { window?: unknown }).window = oldWindow;
  vi.restoreAllMocks();
});

async function mountDeer(deer: ReturnType<typeof makeDeer>["deer"]) {
  oldWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    deer,
    setInterval: () => 1,
    clearInterval: () => undefined,
    confirm: () => true,
  };
  let renderer: ReturnType<typeof rtr.default.create> | null = null;
  await rtr.act(async () => {
    renderer = rtr.default.create(<PollPanel workspaceId="w1" agents={[]} />);
  });
  await rtr.act(async () => {
    await Promise.resolve();
  });
  return renderer as unknown as ReturnType<typeof rtr.default.create>;
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

describe("t152 PollPanel interactions", () => {
  it("casts a vote with the trusted service signature, then closes and renders decision", async () => {
    const fake = makeDeer();
    const renderer = await mountDeer(fake.deer);
    try {
      const checkbox = renderer.root.findAllByType("input").find((input) => input.props.type === "checkbox");
      expect(checkbox).toBeTruthy();
      await rtr.act(async () => {
        (checkbox!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
        await Promise.resolve();
      });
      const submit = buttonByText(renderer.root, "提交投票");
      expect(submit).toBeTruthy();
      await rtr.act(async () => {
        (submit!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(fake.deer.castPoll).toHaveBeenCalledWith("w1", {
        pollId: "p1",
        voterType: "human",
        selections: ["o1"],
      });
      expect(JSON.stringify(fake.deer.castPoll.mock.calls[0])).not.toContain("evil");
      expect(renderer.root.findAll((node) => node.props.role === "status").length).toBeGreaterThan(0);

      const close = buttonByText(renderer.root, "关闭投票");
      expect(close).toBeTruthy();
      await rtr.act(async () => {
        (close!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(fake.deer.closePoll).toHaveBeenCalledWith("w1", { pollId: "p1" });
      expect(JSON.stringify(renderer.toJSON())).toContain("Decision");
      expect(JSON.stringify(renderer.toJSON())).toContain("Approved Poll");
    } finally {
      await rtr.act(async () => renderer.unmount());
    }
  });

  it("supports repeat/change vote and shows an error state", async () => {
    const fake = makeDeer();
    const renderer = await mountDeer(fake.deer);
    try {
      const inputs = renderer.root.findAllByType("input").filter((input) => input.props.type === "checkbox");
      await rtr.act(async () => {
        (inputs[0]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
        await Promise.resolve();
      });
      await rtr.act(async () => {
        (buttonByText(renderer.root, "提交投票")!.props.onClick as () => void)();
        await Promise.resolve();
      });
      await rtr.act(async () => {
        (inputs[1]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
        await Promise.resolve();
      });
      await rtr.act(async () => {
        (buttonByText(renderer.root, "改票")!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(fake.deer.castPoll).toHaveBeenCalledTimes(2);

      fake.deer.castPoll.mockRejectedValueOnce(new Error("cast failed"));
      await rtr.act(async () => {
        (buttonByText(renderer.root, "改票")!.props.onClick as () => void)();
        await Promise.resolve();
      });
      const alerts = renderer.root.findAll((node) => node.props.role === "alert");
      expect(alerts.length).toBeGreaterThan(0);
      expect(textOf(alerts[0]!.props.children)).toContain("cast failed");
    } finally {
      await rtr.act(async () => renderer.unmount());
    }
  });

  it("creates a poll via the modal using Ctrl+Enter and omits client actor fields", async () => {
    const fake = makeDeer();
    const renderer = await mountDeer(fake.deer);
    try {
      await rtr.act(async () => {
        (buttonByText(renderer.root, "新建投票")!.props.onClick as () => void)();
        await Promise.resolve();
      });
      const title = renderer.root.findAllByType("input").find((input) => input.props.placeholder === "例如：下一轮实现哪个系统？");
      expect(title).toBeTruthy();
      await rtr.act(async () => {
        (title!.props.onChange as (event: unknown) => void)({ target: { value: "Next system" } });
        await Promise.resolve();
      });
      const candidates = renderer.root.findAllByType("input").filter((input) => input.props.placeholder === "候选标题");
      expect(candidates).toHaveLength(2);
      await rtr.act(async () => {
        (candidates[0]!.props.onChange as (event: unknown) => void)({ target: { value: "Poll" } });
        (candidates[1]!.props.onChange as (event: unknown) => void)({ target: { value: "Review" } });
        await Promise.resolve();
      });
      const form = renderer.root.findAll((node) => String(node.props.className ?? "").includes("poll-create-form"))[0];
      expect(form).toBeTruthy();
      await rtr.act(async () => {
        (form!.props.onKeyDown as (event: unknown) => void)({ ctrlKey: true, key: "Enter", preventDefault: () => undefined });
        await Promise.resolve();
      });
      expect(fake.deer.createPoll).toHaveBeenCalledTimes(1);
      const input = fake.deer.createPoll.mock.calls[0][0];
      expect(input).not.toHaveProperty("createdBy");
      expect(input).toMatchObject({ workspaceId: "w1", title: "Next system" });
      expect(input.options).toHaveLength(2);
    } finally {
      await rtr.act(async () => renderer.unmount());
    }
  });

  it("does not expose other anonymous ballots or the close action for non-user polls", async () => {
    const anonymous = makeOpenPoll({
      anonymous: true,
      createdBy: "agent-x",
      ballots: [
        { id: "b1", pollId: "p1", voterId: "user", voterType: "human", selections: ["o1"], submittedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", revision: 1 },
        { id: "b2", pollId: "p1", voterId: "other-voter", voterType: "human", selections: ["o2"], submittedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", revision: 1 },
      ],
    });
    const fake = makeDeer();
    fake.deer.listPolls.mockResolvedValue([anonymous]);
    const renderer = await mountDeer(fake.deer);
    try {
      const html = JSON.stringify(renderer.toJSON());
      expect(html).not.toContain("other-voter");
      expect(html).toContain("匿名展示");
      expect(buttonByText(renderer.root, "关闭投票")).toBeUndefined();

      const nonUser = makeOpenPoll({ createdBy: "agent-x" });
      fake.deer.listPolls.mockResolvedValue([nonUser]);
      await rtr.act(async () => {
        (buttonByText(renderer.root, "刷新")!.props.onClick as () => void)();
        await Promise.resolve();
      });
      expect(buttonByText(renderer.root, "关闭投票")).toBeUndefined();
    } finally {
      await rtr.act(async () => renderer.unmount());
    }
  });
});
