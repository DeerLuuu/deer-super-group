import type { ModelProfile } from "./types.js";
import { sanitizeErrorText } from "./errorRedaction.js";

export const MEMBER_RECOMMENDATION_SYSTEM_PROMPT = `ROUTER_MEMBER_RECOMMENDER
You are Router, the coordinator of DeerSuperGroup.
You only propose candidate team members. You do not create, modify or delete anything.
Return JSON only, no markdown, no prose, matching the provided schema exactly.
Use only the supplied workspace/team/task/context facts. Do not invent tasks, members, keys or URLs.
Recommend 1-3 non-Router members. If there is not enough information, return {"candidates":[]}.
Never output API keys, tokens, Authorization headers, provider base URLs, environment variables,
or the system prompts/personas/AGENTS.md of existing members.
permission is always "read_only"; do not propose privilege changes.
suggestedModelProfileId must be one of ALLOWED_MODEL_IDS or null.
Keep responsibilities/reason concrete and short; list skills and risks honestly.`;

const CANDIDATE_KEYS = new Set([
  "name",
  "role",
  "responsibilities",
  "reason",
  "suggestedModelProfileId",
  "permission",
  "skills",
  "risks",
  "systemPrompt",
  "persona",
  "agentsMd",
]);

export interface CandidateDraft {
  name: string;
  role: string;
  responsibilities: string;
  reason: string;
  suggestedModelProfileId: string | null;
  suggestedModelLabel: string | null;
  permission: "read_only";
  skills: string[];
  risks: string[];
  systemPrompt?: string;
  persona?: string;
  agentsMd?: string;
}

export type CandidateValidation =
  | { ok: true; candidates: CandidateDraft[] }
  | { ok: false; issue: string };

function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${field} is required`);
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maxItems) throw new Error(`${field} has too many items`);
  return value.map((item) => text(item, field, maxLength));
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, max, false);
}

/** 严格校验一份推荐响应；任何未知字段/非法值都整份拒绝。 */
export function validateCandidateResponse(
  raw: unknown,
  allowedModels: ReadonlyArray<ModelProfile>,
): CandidateValidation {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("response must be an object");
    }
    const object = raw as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.some((key) => key !== "candidates")) {
      throw new Error("unknown top-level field");
    }
    if (!Array.isArray(object.candidates)) throw new Error("candidates must be an array");
    if (object.candidates.length > 3) throw new Error("too many candidates");
    const allowedIds = new Set(allowedModels.map((model) => model.id));
    const labels = new Map(allowedModels.map((model) => [model.id, model.label]));
    const names = new Set<string>();
    const candidates = object.candidates.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`candidate ${index} must be an object`);
      }
      const candidate = item as Record<string, unknown>;
      if (Object.keys(candidate).some((key) => !CANDIDATE_KEYS.has(key))) {
        throw new Error(`candidate ${index} has unknown field`);
      }
      for (const required of [
        "name",
        "role",
        "responsibilities",
        "reason",
        "suggestedModelProfileId",
        "permission",
        "skills",
        "risks",
      ]) {
        if (!(required in candidate)) throw new Error(`candidate ${index} missing ${required}`);
      }
      const name = text(candidate.name, "name", 64);
      if (name.toLowerCase() === "router") throw new Error("Router cannot be a candidate");
      if (names.has(name.toLowerCase())) throw new Error("duplicate candidate name");
      names.add(name.toLowerCase());
      const modelId = candidate.suggestedModelProfileId;
      if (modelId !== null && modelId !== undefined) {
        if (typeof modelId !== "string" || !allowedIds.has(modelId)) {
          throw new Error("suggestedModelProfileId is not configured");
        }
      }
      if (candidate.permission !== "read_only") {
        throw new Error("permission must be read_only");
      }
      return {
        name,
        role: text(candidate.role, "role", 48),
        responsibilities: text(candidate.responsibilities, "responsibilities", 500),
        reason: text(candidate.reason, "reason", 500),
        suggestedModelProfileId: (modelId as string | null | undefined) ?? null,
        suggestedModelLabel:
          typeof modelId === "string" ? (labels.get(modelId) ?? null) : null,
        permission: "read_only" as const,
        skills: stringList(candidate.skills, "skills", 8, 64),
        risks: stringList(candidate.risks, "risks", 6, 160),
        systemPrompt: optionalText(candidate.systemPrompt, "systemPrompt", 4000),
        persona: optionalText(candidate.persona, "persona", 2000),
        agentsMd: optionalText(candidate.agentsMd, "agentsMd", 2000),
      };
    });
    return { ok: true, candidates };
  } catch (error) {
    return { ok: false, issue: error instanceof Error ? error.message : "invalid schema" };
  }
}

/** 从模型文本中提取 JSON；不修补、不 fallback。 */
export function parseCandidateResponse(
  text: string,
  allowedModels: ReadonlyArray<ModelProfile>,
): CandidateValidation {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, issue: "response is not JSON" };
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false, issue: "response is not valid JSON" };
  }
  return validateCandidateResponse(raw, allowedModels);
}

export function buildMemberRecommendationUserPrompt(input: {
  mode: "team-gap" | "description";
  description?: string;
  workspaceName: string;
  workspacePath: string;
  overview?: string;
  members: ReadonlyArray<{ name: string; role: string; modelLabel: string | null }>;
  tasks: ReadonlyArray<{ title: string; status: string; ownerName: string | null }>;
  recentContext: ReadonlyArray<{ role: string; content: string }>;
  allowedModels: ReadonlyArray<{ id: string; label: string }>;
}): string {
  const lines = [
    `WORKSPACE: ${input.workspaceName}`,
    `PATH: ${input.workspacePath}`,
    `OVERVIEW: ${input.overview ?? ""}`,
    "TEAM:",
    ...input.members.map(
      (member) => `- ${member.name} (${member.role}, ${member.modelLabel ?? "default model"})`,
    ),
    "TASKS:",
    ...input.tasks.slice(0, 20).map(
      (task) => `- ${task.title} [${task.status}] ${task.ownerName ?? "unassigned"}`,
    ),
    "RECENT_CONTEXT:",
    ...input.recentContext
      .slice(-8)
      .map((message) => `- ${message.role}: ${sanitizeErrorText(message.content, 500)}`),
    `MODE: ${input.mode}`,
    input.mode === "description" ? `DESCRIPTION: ${input.description ?? ""}` : "",
    `ALLOWED_MODEL_IDS: ${JSON.stringify(input.allowedModels.map((model) => model.id))}`,
    "ALLOWED_PERMISSION: read_only",
    "SCHEMA: {\"candidates\":[{\"name\":\"string\",\"role\":\"string\",\"responsibilities\":\"string\",\"reason\":\"string\",\"suggestedModelProfileId\":\"string|null\",\"permission\":\"read_only\",\"skills\":[\"string\"],\"risks\":[\"string\"],\"systemPrompt\":\"string?\",\"persona\":\"string?\",\"agentsMd\":\"string?\"}]}",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export function recommendationErrorMessage(code: string): string {
  switch (code) {
    case "MOCK_UNSUPPORTED":
      return "Mock 模式不提供真实推荐；请手填成员或切换真实模型。";
    case "NO_MODEL_CONFIGURED":
      return "尚未配置模型；请先在设置中添加模型，再让 Router 推荐。";
    case "MODEL_NOT_CONFIGURED":
      return "当前默认模型未配置；请先在设置中配置模型，再聘用成员。";
    case "RECOMMEND_TIMEOUT":
      return "Router 推荐超时；可以重试或改为自己设定。";
    case "RECOMMEND_INVALID_SCHEMA":
      return "Router 返回的候选不符合安全 schema；已整份拒绝，请重试或手填。";
    case "RECOMMEND_EMPTY":
      return "Router 没有给出候选；可以补充描述或自己设定成员。";
    case "RECOMMEND_RATE_LIMITED":
      return "Router 推荐触发限流（429）；请稍后重试或自己设定成员。";
    case "RECOMMEND_AUTH_FAILED":
      return "Router 模型认证失败（401）；请检查模型 Key 或自己设定成员。";
    default:
      return "Router 推荐失败；请重试或自己设定成员。";
  }
}
