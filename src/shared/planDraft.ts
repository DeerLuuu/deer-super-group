import type { Agent, Task } from "./types.js";

/** P0-4：Plan Draft 只存在于 renderer 会话；不落库、不进 Snapshot。 */
export const PLAN_SOURCE_MAX = 12_000;
export const PLAN_MAX_TASKS = 12;

export type PlanGoalSource = "composer" | "last_user_message" | "edited";

export interface PlanSourceMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface PlanSource {
  goal: string;
  goalSource: PlanGoalSource;
  messages: PlanSourceMessage[];
  summary: string;
  overview: string;
  characterCount: number;
  digest: string;
}

export interface PlanDraftTask {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  ownerId: string | null;
  priority: number;
  risks: string[];
  unknowns: string[];
}

export interface PlanDraft {
  source: PlanSource;
  tasks: PlanDraftTask[];
}

export type PlanIssueSeverity = "error" | "warning" | "info";

export interface PlanIssue {
  code: string;
  severity: PlanIssueSeverity;
  message: string;
  taskId?: string;
}

export interface PlanContract {
  source: "owner" | "mixed" | "unavailable";
  ownerId: string | null;
  model: string | null;
  permission: string | null;
  label: string;
}

export interface PreviewPlanResult {
  ok: boolean;
  draft?: PlanDraft;
  issues: PlanIssue[];
  error?: string;
}

export interface ConfirmPlanRequest {
  workspaceId: string;
  sourceDigest: string;
  idempotencyKey: string;
  tasks: PlanDraftTask[];
  ackHighRisk: boolean;
}

export interface ConfirmPlanResult {
  tasks: Task[];
  alreadyConfirmed: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** 32-bit FNV-1a；只用于 source/draft 指纹，不作为安全哈希。 */
export function planDigest(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildPlanSource(input: {
  goal: string;
  goalSource?: PlanGoalSource;
  messages: PlanSourceMessage[];
  summary?: string;
  overview?: string;
}): PlanSource {
  const goal = input.goal.trim();
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const characters =
    goal.length +
    messages.reduce((sum, message) => sum + message.content.length, 0) +
    (input.summary?.length ?? 0) +
    (input.overview?.length ?? 0);
  return {
    goal,
    goalSource: input.goalSource ?? "composer",
    messages,
    summary: input.summary ?? "",
    overview: input.overview ?? "",
    characterCount: characters,
    digest: planDigest({ goal, messages, summary: input.summary ?? "", overview: input.overview ?? "" }),
  };
}

export function planSourceIssues(source: PlanSource): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!source.goal && source.messages.length === 0) {
    issues.push({ code: "SOURCE_EMPTY", severity: "error", message: "没有可规划的当前目标或对话" });
  }
  if (source.characterCount > PLAN_SOURCE_MAX) {
    issues.push({
      code: "SOURCE_TOO_LARGE",
      severity: "error",
      message: `规划源 ${source.characterCount} 字符，超过上限 ${PLAN_SOURCE_MAX}；请先 /compact 或仅使用输入框目标`,
    });
  }
  return issues;
}

function hasCycle(tasks: PlanDraftTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const task = byId.get(id);
    if (!task) return false;
    visiting.add(id);
    for (const dep of task.dependsOn) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

/** client/server 共用；服务端会重新用当前 agents/tasks 再验一次。 */
export function validatePlanDraft(
  tasks: PlanDraftTask[],
  ctx: { agents?: readonly Pick<Agent, "id" | "isRouter">[] } = {},
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (tasks.length === 0) {
    issues.push({ code: "PLAN_EMPTY", severity: "error", message: "草案至少需要一个任务" });
    return issues;
  }
  if (tasks.length > PLAN_MAX_TASKS) {
    issues.push({
      code: "PLAN_TOO_LARGE",
      severity: "error",
      message: `任务数 ${tasks.length} 超过上限 ${PLAN_MAX_TASKS}；请拆批`,
    });
  }
  const ids = new Set(tasks.map((task) => task.id));
  const titles = new Set<string>();
  const ownerIds = new Set((ctx.agents ?? []).filter((agent) => !agent.isRouter).map((agent) => agent.id));
  for (const task of tasks) {
    if (!task.title.trim()) {
      issues.push({ code: "TASK_TITLE_EMPTY", severity: "error", message: "任务标题不能为空", taskId: task.id });
    }
    if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100) {
      issues.push({ code: "TASK_PRIORITY_INVALID", severity: "error", message: "优先级需为 0–100 的整数", taskId: task.id });
    }
    const normalized = task.title.trim().toLowerCase();
    if (normalized && titles.has(normalized)) {
      issues.push({ code: "TASK_TITLE_DUPLICATE", severity: "warning", message: "任务标题重复", taskId: task.id });
    }
    titles.add(normalized);
    if (task.acceptance.every((item) => !item.trim())) {
      issues.push({ code: "TASK_ACCEPTANCE_EMPTY", severity: "warning", message: "验收标准为空，建议补充", taskId: task.id });
    }
    if (!task.ownerId) {
      issues.push({ code: "TASK_OWNER_EMPTY", severity: "warning", message: "未分配负责人，确认后可在任务页分配", taskId: task.id });
    } else if (ctx.agents && !ownerIds.has(task.ownerId)) {
      issues.push({ code: "TASK_OWNER_MISSING", severity: "error", message: "负责人不存在或不可用", taskId: task.id });
    }
    if (task.dependsOn.includes(task.id)) {
      issues.push({ code: "TASK_SELF_DEPENDENCY", severity: "error", message: "任务不能依赖自身", taskId: task.id });
    }
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({ code: "TASK_DEPENDENCY_MISSING", severity: "error", message: "依赖任务不存在", taskId: task.id });
      }
    }
  }
  if (hasCycle(tasks)) {
    issues.push({ code: "PLAN_CYCLE", severity: "error", message: "任务依赖存在环" });
  }
  return issues;
}

export function planDraftFingerprint(draft: PlanDraft): string {
  return planDigest({
    sourceDigest: draft.source.digest,
    tasks: draft.tasks.map((task) => ({
      title: task.title,
      description: task.description,
      acceptance: task.acceptance,
      dependsOn: task.dependsOn,
      ownerId: task.ownerId,
      priority: task.priority,
      risks: task.risks,
      unknowns: task.unknowns,
    })),
  });
}

export function planContractForTask(
  task: PlanDraftTask,
  agents: readonly Agent[],
): PlanContract {
  if (!task.ownerId) {
    return { source: "unavailable", ownerId: null, model: null, permission: null, label: "未分配负责人" };
  }
  const owner = agents.find((agent) => agent.id === task.ownerId);
  if (!owner) {
    return { source: "unavailable", ownerId: task.ownerId, model: null, permission: null, label: "负责人不可用" };
  }
  return {
    source: "owner",
    ownerId: owner.id,
    model: owner.model,
    permission: owner.permission,
    label: `${owner.name} · ${owner.model ?? "默认模型"} · ${owner.permission}`,
  };
}

export function hasHighRiskTask(tasks: readonly PlanDraftTask[]): boolean {
  return tasks.some((task) =>
    /delete|drop|migrat|secret|permission|credential|rm -rf|迁移|删除|权限|密钥/i.test(
      `${task.title} ${task.description}`,
    ),
  );
}

export const PLAN_DRAFT_SYSTEM_PROMPT = [
  "ROUTER_PLANNER",
  "You are the planning mode of Router in DeerSuperGroup.",
  "Return JSON only with this shape:",
  '{"tasks":[{"title":"...","description":"...","acceptance":["..."],"dependsOn":[],"priority":50,"risks":[],"unknowns":[]}]}',
  "dependsOn contains zero-based indexes of earlier tasks.",
  "Keep the plan small: 2-4 tasks, never more than 12.",
  "Do not invent owners; ownerId must be null.",
].join("\n");

export function buildPlanDraftPrompt(source: PlanSource): string {
  return [
    `GOAL (${source.goalSource}):`,
    source.goal || "(empty)",
    `MESSAGES (${source.messages.length}):`,
    ...source.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    `SUMMARY:\n${source.summary || "(none)"}`,
    `WORKSPACE OVERVIEW:\n${source.overview || "(none)"}`,
  ].join("\n\n");
}

/** 容错提取 JSON；不 fallback 单任务，坏 JSON 让 preview 报 PLAN_UNPARSEABLE。 */
export function parsePlanDraft(text: string): PlanDraftTask[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("PLAN_UNPARSEABLE");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    tasks?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("PLAN_UNPARSEABLE");
  }
  const raw = parsed.tasks;
  return raw.map((task, index) => {
    const id = `draft-${index + 1}`;
    const depends = Array.isArray(task.dependsOn)
      ? task.dependsOn
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item >= 0 && item < raw.length)
          .map((item) => `draft-${item + 1}`)
      : [];
    return {
      id,
      title: String(task.title ?? "").trim(),
      description: String(task.description ?? ""),
      acceptance: Array.isArray(task.acceptance)
        ? task.acceptance.map((item) => String(item))
        : [],
      dependsOn: [...new Set(depends)],
      ownerId: null,
      priority: Number.isInteger(Number(task.priority)) ? Number(task.priority) : 50,
      risks: Array.isArray(task.risks) ? task.risks.map((item) => String(item)) : [],
      unknowns: Array.isArray(task.unknowns)
        ? task.unknowns.map((item) => String(item))
        : [],
    };
  });
}
