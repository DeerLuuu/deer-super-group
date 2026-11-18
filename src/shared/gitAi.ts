import { sanitizeErrorText } from "./errorRedaction.js";
import { z } from "zod";

/**
 * t368/G2：Git × AI 共享契约。
 * 所有进入外部模型的自由文本必须先 sanitize + cap；此文件不依赖 Node。
 */

export type GitAiDraftKind = "pr" | "merge";

export interface GitAiDraft {
  title: string;
  body: string;
}

export interface GitAiDraftRequest {
  workspaceId: string;
  agentId: string;
  kind: GitAiDraftKind;
  taskId?: string;
  headSha?: string;
}

export interface GitAiDraftResponseSuccess {
  ok: true;
  draft: GitAiDraft;
  agentName: string;
  modelLabel: string;
  generatedAt: string;
}

export interface GitAiDraftResponseFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

export type GitAiDraftResponse = GitAiDraftResponseSuccess | GitAiDraftResponseFailure;

export interface GitMergeNotifyRequest {
  workspaceId: string;
  taskId: string;
  agentId: string;
  body?: string;
  prNumber?: number | null;
  branch?: string | null;
  mergeCommitSha?: string | null;
}

export interface GitMergeNotifySuccess {
  ok: true;
  messageId: string;
  threadId: string;
  agentName: string;
  subject: string;
  body: string;
}

export interface GitMergeNotifyFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

export type GitMergeNotifyResponse = GitMergeNotifySuccess | GitMergeNotifyFailure;

export interface CreatePrDraftInput {
  title?: string;
  body?: string;
}

const gitAiId = z.string().trim().min(1).max(200);

export const GIT_AI_LIMITS = {
  promptText: 4_000,
  diffSummary: 16_000,
  draftTitle: 120,
  draftBody: 12_000,
  notificationBody: 4_000,
} as const;

export const gitAiDraftRequestSchema = z
  .object({
    workspaceId: gitAiId,
    agentId: gitAiId,
    kind: z.enum(["pr", "merge"]),
    taskId: gitAiId.optional(),
    headSha: z.string().max(80).optional(),
  })
  .strict();

export const gitCreatePrDraftSchema = z
  .object({
    title: z.string().max(GIT_AI_LIMITS.draftTitle).optional(),
    body: z.string().max(GIT_AI_LIMITS.draftBody).optional(),
  })
  .strict();

export const gitMergeNotifySchema = z
  .object({
    workspaceId: gitAiId,
    taskId: gitAiId,
    agentId: gitAiId,
    body: z.string().max(GIT_AI_LIMITS.notificationBody).optional(),
    prNumber: z.number().int().nullable().optional(),
    branch: z.string().max(200).nullable().optional(),
    mergeCommitSha: z.string().max(80).nullable().optional(),
  })
  .strict();

/** t280 的共享脱敏机制；collapsed 单行适合作为模型上下文片段。 */
export function sanitizeGitAiText(
  value: unknown,
  max: number = GIT_AI_LIMITS.promptText,
): string {
  return sanitizeErrorText(value == null ? "" : String(value), max);
}

export function capLooseText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .slice(0, Math.max(0, max))
    .trimEnd();
}

export function buildGitAiMessages(input: {
  kind: GitAiDraftKind;
  agentName: string;
  agentRole: string;
  agentSystemPrompt: string;
  workspaceName: string;
  taskTitle: string;
  taskDescription: string;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  prSummary: string;
  mergeSummary: string;
  diffSummary: string;
}): Array<{ role: "system" | "user"; content: string }> {
  const systemPrompt =
    input.kind === "pr"
      ? "你是资深软件工程师，负责为 Pull Request 写清晰、准确的中文标题与描述。只输出 JSON：{\"title\":\"...\",\"body\":\"...\"}。标题<=100字符，正文用 Markdown，包含变更要点、测试/验证与风险（若上下文没有就写未提供），不要编造事实。"
      : "你是资深发布工程师，负责写合并说明。只输出 JSON：{\"title\":\"...\",\"body\":\"...\"}。标题<=100字符，正文用 Markdown，概括分支/PR/变更与合并后注意事项；不要编造事实。";
  const payload = {
    kind: input.kind,
    agent: sanitizeGitAiText(input.agentName, 120),
    role: sanitizeGitAiText(input.agentRole, 160),
    workspace: sanitizeGitAiText(input.workspaceName, 200),
    task: {
      title: sanitizeGitAiText(input.taskTitle, 300),
      description: sanitizeGitAiText(input.taskDescription, GIT_AI_LIMITS.promptText),
    },
    branch: input.branch ? sanitizeGitAiText(input.branch, 200) : null,
    baseBranch: input.baseBranch ? sanitizeGitAiText(input.baseBranch, 200) : null,
    headSha: input.headSha ? sanitizeGitAiText(input.headSha, 80) : null,
    pr: sanitizeGitAiText(input.prSummary, 1_000),
    merge: sanitizeGitAiText(input.mergeSummary, 1_000),
    diffSummary: sanitizeGitAiText(input.diffSummary, GIT_AI_LIMITS.diffSummary),
    constraints: [
      "所有上下文已脱敏；不得在输出中复述密钥、token、Authorization、Cookie、内部 URL。",
      "只输出一个 JSON 对象，不要代码围栏或额外解释。",
    ],
  };
  return [
    {
      role: "system",
      content:
        `${systemPrompt}\n\n成员身份（仅用于语气，不改变事实）：${sanitizeGitAiText(input.agentName, 120)} / ${sanitizeGitAiText(input.agentRole, 160)}。\n` +
        (input.agentSystemPrompt
          ? `成员系统提示（已脱敏）：${sanitizeGitAiText(input.agentSystemPrompt, 2_000)}`
          : ""),
    },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

export function parseGitAiDraft(text: string): GitAiDraft | null {
  const cleaned = String(text ?? "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  let parsed: unknown = null;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as { title?: unknown; body?: unknown };
    if (typeof record.title === "string" && typeof record.body === "string") {
      const draft = normalizeDraft(record.title, record.body);
      if (draft) return draft;
    }
  }
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const title = lines[0]!.replace(/^#+\s*/, "");
  const body = lines.slice(1).join("\n");
  return normalizeDraft(title, body || title);
}

function normalizeDraft(title: string, body: string): GitAiDraft | null {
  const cleanTitle = capLooseText(title, GIT_AI_LIMITS.draftTitle).replace(/\s+/g, " ").trim();
  const cleanBody = capLooseText(body, GIT_AI_LIMITS.draftBody).trim();
  if (!cleanTitle || !cleanBody) return null;
  return { title: cleanTitle, body: cleanBody };
}
