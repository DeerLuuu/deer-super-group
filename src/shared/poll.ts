import type { Id } from "./types.js";

export type PollScope = "workspace" | "team" | "task" | "board";
export type PollMode = "single" | "multi";
export type PollThresholdRule = "gt" | "majority" | "percent";
export type PollStatus = "draft" | "open" | "closed" | "expired";
export type PollVoterType = "human" | "agent";
export type PollOptionSource = "board" | "task" | "manual" | "doc";

export interface PollOption {
  id: Id;
  pollId: Id;
  label: string;
  description: string;
  sourceType: PollOptionSource;
  sourceId: string | null;
  sortOrder: number;
}

export interface PollBallot {
  id: Id;
  pollId: Id;
  voterId: string;
  voterType: PollVoterType;
  selections: Id[];
  submittedAt: string;
  updatedAt: string;
  /** 每次改票递增；同一 voter 只有一条 ballot。 */
  revision: number;
}

export interface PollDecision {
  id: Id;
  pollId: Id;
  workspaceId: Id;
  adoptedOptionIds: Id[];
  insufficientQuorum: boolean;
  summary: string;
  boardEntryId: Id | null;
  createdAt: string;
}

export interface PollOptionResult {
  optionId: Id;
  label: string;
  count: number;
  percent: number;
  adopted: boolean;
}

export interface PollResult {
  totalBallots: number;
  thresholdRule: PollThresholdRule;
  thresholdValue: number;
  quorum: number;
  quorumMet: boolean;
  insufficientQuorum: boolean;
  adoptedOptionIds: Id[];
  options: PollOptionResult[];
}

export interface Poll {
  id: Id;
  workspaceId: Id;
  scope: PollScope;
  scopeId: string | null;
  title: string;
  description: string;
  mode: PollMode;
  maxSelections: number | null;
  thresholdRule: PollThresholdRule;
  thresholdValue: number;
  quorum: number;
  allowAbstain: boolean;
  anonymous: boolean;
  status: PollStatus;
  createdBy: string;
  createdAt: string;
  closesAt: string | null;
  closedAt: string | null;
  decisionRef: string | null;
  options: PollOption[];
  ballots: PollBallot[];
  result: PollResult;
  decision: PollDecision | null;
}

export interface CreatePollInput {
  workspaceId: Id;
  scope: PollScope;
  scopeId?: string | null;
  title: string;
  description?: string;
  mode: PollMode;
  maxSelections?: number | null;
  thresholdRule?: PollThresholdRule;
  thresholdValue?: number;
  quorum?: number;
  allowAbstain?: boolean;
  anonymous?: boolean;
  closesAt?: string | null;
  options: Array<{
    label: string;
    description?: string;
    sourceType?: PollOptionSource;
    sourceId?: string | null;
  }>;
  createdBy: string;
}

export interface CastPollInput {
  pollId: Id;
  voterId: string;
  voterType: PollVoterType;
  selections: Id[];
}

export interface ClosePollInput {
  pollId: Id;
  actor: string;
  reason?: string;
}

/** Renderer 可提交的创建请求：createdBy 由主进程绑定为本地 human。 */
export type CreatePollRequest = Omit<CreatePollInput, "createdBy">;

/** Renderer 可提交的投票请求：human 的 voterId 由主进程固定为 user。 */
export interface CastPollRequest {
  pollId: Id;
  voterType: PollVoterType;
  selections: Id[];
  /** 仅 agent 使用；human 会被主进程忽略。 */
  voterId?: string;
}

/** Renderer 可提交的关闭请求：actor 由主进程绑定为本地 human。 */
export interface ClosePollRequest {
  pollId: Id;
  reason?: string;
}

export class PollError extends Error {
  readonly code:
    | "POLL_INVALID_INPUT"
    | "POLL_NOT_FOUND"
    | "POLL_CLOSED"
    | "POLL_EXPIRED"
    | "POLL_FORBIDDEN"
    | "POLL_QUORUM"
    | "POLL_CONFLICT";

  constructor(code: PollError["code"], message: string) {
    super(message);
    this.name = "PollError";
    this.code = code;
  }
}

export interface NormalizedCreatePoll {
  workspaceId: Id;
  scope: PollScope;
  scopeId: string | null;
  title: string;
  description: string;
  mode: PollMode;
  maxSelections: number | null;
  thresholdRule: PollThresholdRule;
  thresholdValue: number;
  quorum: number;
  allowAbstain: boolean;
  anonymous: boolean;
  closesAt: string | null;
  options: Array<{
    label: string;
    description: string;
    sourceType: PollOptionSource;
    sourceId: string | null;
  }>;
  createdBy: string;
}

export function normalizeIso(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new PollError("POLL_INVALID_INPUT", "截止时间格式无效");
  return new Date(ms).toISOString();
}

export function normalizeCreatePoll(input: CreatePollInput): NormalizedCreatePoll {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) {
    throw new PollError("POLL_INVALID_INPUT", "投票标题需为 1–200 字");
  }
  const options = input.options
    .map((option) => ({
      label: option.label.trim(),
      description: (option.description ?? "").trim(),
      sourceType: option.sourceType ?? "manual",
      sourceId: option.sourceId ?? null,
    }))
    .filter((option) => option.label.length > 0);
  if (options.length < 2 || options.length > 50) {
    throw new PollError("POLL_INVALID_INPUT", "候选需为 2–50 个");
  }
  for (const option of options) {
    if (option.label.length > 200 || option.description.length > 1000) {
      throw new PollError("POLL_INVALID_INPUT", "候选标题或说明过长");
    }
  }
  const mode = input.mode;
  if (mode !== "single" && mode !== "multi") {
    throw new PollError("POLL_INVALID_INPUT", "投票模式无效");
  }
  const maxSelections =
    mode === "single" ? 1 : input.maxSelections == null ? null : Number(input.maxSelections);
  if (maxSelections !== null) {
    if (!Number.isInteger(maxSelections) || maxSelections < 1) {
      throw new PollError("POLL_INVALID_INPUT", "最多可选数必须为正整数");
    }
    if (maxSelections > options.length) {
      throw new PollError("POLL_INVALID_INPUT", "最多可选数不能超过候选数");
    }
    if (mode === "single" && maxSelections !== 1) {
      throw new PollError("POLL_INVALID_INPUT", "单选只能选 1 项");
    }
  }
  const thresholdRule = input.thresholdRule ?? "gt";
  if (!["gt", "majority", "percent"].includes(thresholdRule)) {
    throw new PollError("POLL_INVALID_INPUT", "阈值规则无效");
  }
  const thresholdValue = input.thresholdValue ?? (thresholdRule === "gt" ? 3 : thresholdRule === "percent" ? 50 : 0);
  if (thresholdRule === "gt" && (!Number.isInteger(thresholdValue) || thresholdValue < 0)) {
    throw new PollError("POLL_INVALID_INPUT", "票数阈值必须为非负整数");
  }
  if (thresholdRule === "percent" && (!Number.isFinite(thresholdValue) || thresholdValue < 1 || thresholdValue > 100)) {
    throw new PollError("POLL_INVALID_INPUT", "百分比阈值需为 1–100");
  }
  if (thresholdRule === "majority" && thresholdValue !== 0) {
    throw new PollError("POLL_INVALID_INPUT", "majority 阈值不使用 thresholdValue");
  }
  const quorum = input.quorum == null ? 0 : Number(input.quorum);
  if (!Number.isInteger(quorum) || quorum < 0 || quorum > 1000) {
    throw new PollError("POLL_INVALID_INPUT", "quorum 需为 0–1000 的整数");
  }
  const closesAt = normalizeIso(input.closesAt ?? null);
  if (closesAt && Date.parse(closesAt) <= Date.now()) {
    throw new PollError("POLL_INVALID_INPUT", "截止时间必须晚于现在");
  }
  return {
    workspaceId: input.workspaceId,
    scope: input.scope,
    scopeId: input.scopeId ?? null,
    title,
    description: (input.description ?? "").trim(),
    mode,
    maxSelections,
    thresholdRule,
    thresholdValue,
    quorum,
    allowAbstain: input.allowAbstain === true,
    anonymous: input.anonymous === true,
    closesAt,
    options,
    createdBy: input.createdBy,
  };
}

export function validateSelections(
  poll: Pick<Poll, "mode" | "maxSelections" | "allowAbstain"> & { options: Array<{ id: string }> },
  selections: string[],
): string[] {
  if (!Array.isArray(selections)) throw new PollError("POLL_INVALID_INPUT", "投票选项格式无效");
  const unique = [...new Set(selections)];
  const allowed = new Set(poll.options.map((option) => option.id));
  if (unique.some((id) => !allowed.has(id))) {
    throw new PollError("POLL_INVALID_INPUT", "包含不属于该投票的候选");
  }
  if (poll.mode === "single" && unique.length > 1) {
    throw new PollError("POLL_INVALID_INPUT", "单选只能选择 1 项");
  }
  if (poll.maxSelections !== null && unique.length > poll.maxSelections) {
    throw new PollError("POLL_INVALID_INPUT", `最多选择 ${poll.maxSelections} 项`);
  }
  if (!poll.allowAbstain && unique.length === 0) {
    throw new PollError("POLL_INVALID_INPUT", "该投票不允许弃权");
  }
  return unique;
}

export function evaluatePoll(
  poll: Pick<
    Poll,
    "id" | "mode" | "maxSelections" | "allowAbstain" | "thresholdRule" | "thresholdValue" | "quorum"
  > & { options: Array<{ id: string; label: string }> },
  ballots: Array<Pick<PollBallot, "selections">>,
): PollResult {
  const totalBallots = ballots.length;
  const counts = new Map<string, number>();
  for (const option of poll.options) counts.set(option.id, 0);
  for (const ballot of ballots) {
    for (const id of new Set(ballot.selections)) {
      if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const quorumMet = poll.quorum <= 0 || totalBallots >= poll.quorum;
  const adopted = new Set<string>();
  const options: PollOptionResult[] = poll.options.map((option) => {
    const count = counts.get(option.id) ?? 0;
    const percent = totalBallots === 0 ? 0 : count / totalBallots;
    const meetsThreshold =
      quorumMet &&
      (poll.thresholdRule === "gt"
        ? count > poll.thresholdValue
        : poll.thresholdRule === "majority"
          ? totalBallots > 0 && count > totalBallots / 2
          : totalBallots > 0 && percent * 100 >= poll.thresholdValue);
    if (meetsThreshold) adopted.add(option.id);
    return {
      optionId: option.id,
      label: option.label,
      count,
      percent: Math.round(percent * 1000) / 10,
      adopted: meetsThreshold,
    };
  });
  return {
    totalBallots,
    thresholdRule: poll.thresholdRule,
    thresholdValue: poll.thresholdValue,
    quorum: poll.quorum,
    quorumMet,
    insufficientQuorum: !quorumMet,
    adoptedOptionIds: [...adopted],
    options,
  };
}

export function isPollExpired(poll: Pick<Poll, "status" | "closesAt">, nowIso: string): boolean {
  if (poll.status !== "open" || !poll.closesAt) return false;
  return Date.parse(poll.closesAt) <= Date.parse(nowIso);
}

export function decisionSummary(poll: Pick<Poll, "title">, result: PollResult): string {
  if (result.insufficientQuorum) {
    return `投票「${poll.title}」未达到 quorum（${result.totalBallots}/${result.quorum}），不产生采纳项。`;
  }
  if (result.adoptedOptionIds.length === 0) {
    return `投票「${poll.title}」已完成，没有候选达到阈值。`;
  }
  const labels = result.options
    .filter((option) => option.adopted)
    .map((option) => `${option.label}（${option.count} 票）`)
    .join("；");
  return `投票「${poll.title}」采纳：${labels}。`;
}
