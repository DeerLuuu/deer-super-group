import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PollResults, formatRemaining, pollStatusLabel, thresholdLabel } from "./PollPanel";
import type { Poll } from "../shared/poll";

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
    expect(html).toContain("达到 quorum");
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
    expect(html).toContain("未达 quorum");
    expect(html).toContain("不产生采纳项");
    expect(html).not.toContain("已写入黑板");
  });
});
