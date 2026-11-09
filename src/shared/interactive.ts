import { z } from "zod";

/**
 * t64：交互画布与提问表单共享协议层（依据 docs/team/interactive-canvas-design.md §5/§6/§8）。
 *
 * 本文件同时运行在主进程与 renderer：
 * - 不 import 任何 node: 模块；
 * - 不执行模型输出（只 JSON.parse + zod 白名单校验）；
 * - 所有进入 UI/DB 的文本先做控制字符/双向控制符清洗；
 * - 解析要么整体成功，要么整体失败（DEC-11），绝不渲染半张图。
 */

export const CANVAS_PROTOCOL = "deer-canvas" as const;
export const CANVAS_VERSION = 1 as const;
export const QUESTION_PROTOCOL = "deer-question" as const;
export const QUESTION_VERSION = 1 as const;

export const CANVAS_KINDS = ["mindmap", "flowchart", "roadmap", "dependency"] as const;
export const CANVAS_STATUSES = [
  "planned",
  "active",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
] as const;
export const NODE_KINDS = [
  "root",
  "topic",
  "step",
  "task",
  "milestone",
  "note",
  "decision",
  "risk",
] as const;
export const EDGE_KINDS = ["flow", "depends", "contains", "relates"] as const;
export const GROUP_TONES = ["accent", "purple", "green", "yellow", "red", "neutral"] as const;

export type CanvasKind = (typeof CANVAS_KINDS)[number];
export type CanvasStatus = (typeof CANVAS_STATUSES)[number];
export type CanvasNodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type GroupTone = (typeof GROUP_TONES)[number];
export type CanvasDirection = "TB" | "LR";

/** 节点/分组/边/字段/选项 id 的白名单：1–64 个 ASCII 字母数字/_/-。 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const Id = z.string().regex(ID_PATTERN, "id 只能包含字母/数字/_/-，1–64 字符");

export const CANVAS_LIMITS = {
  nodes: 80,
  edges: 240,
  groups: 12,
  title: 160,
  summary: 400,
  label: 120,
  note: 600,
  meta: 80,
  edgeLabel: 40,
  groupLabel: 60,
  jsonBytes: 64 * 1024,
  blocksPerMessage: 6,
  questionsPerMessage: 3,
  canvasesPerMessage: 3,
} as const;

export const QUESTION_LIMITS = {
  fields: 6,
  options: 12,
  title: 120,
  description: 400,
  label: 80,
  optionDescription: 160,
  textMaxLength: 4000,
  answerBytes: 16 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Canvas schema（设计 §5.3）
// ---------------------------------------------------------------------------

export const CanvasNodeSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(CANVAS_LIMITS.label),
  kind: z.enum(NODE_KINDS).default("step"),
  status: z.enum(CANVAS_STATUSES).default("planned"),
  note: z.string().trim().max(CANVAS_LIMITS.note).optional(),
  meta: z.string().trim().max(CANVAS_LIMITS.meta).optional(),
  groupId: Id.optional(),
  order: z.number().int().min(0).max(99).optional(),
  refs: z
    .strictObject({
      taskId: z.string().trim().min(1).max(64).optional(),
      messageId: z.string().trim().min(1).max(64).optional(),
      board: z.string().trim().min(1).max(64).optional(),
    })
    .optional(),
});

export const CanvasEdgeSchema = z.strictObject({
  id: Id.optional(),
  from: Id,
  to: Id,
  kind: z.enum(EDGE_KINDS).default("flow"),
  label: z.string().trim().max(CANVAS_LIMITS.edgeLabel).optional(),
});

export const CanvasGroupSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(CANVAS_LIMITS.groupLabel),
  order: z.number().int().min(0).max(99).optional(),
  tone: z.enum(GROUP_TONES).optional(),
  status: z.enum(CANVAS_STATUSES).optional(),
});

export const CanvasSchema = z
  .strictObject({
    protocol: z.literal(CANVAS_PROTOCOL),
    version: z.literal(CANVAS_VERSION),
    kind: z.enum(CANVAS_KINDS),
    title: z.string().trim().min(1).max(CANVAS_LIMITS.title),
    summary: z.string().trim().max(CANVAS_LIMITS.summary).optional(),
    direction: z.enum(["TB", "LR"]).optional(),
    nodes: z.array(CanvasNodeSchema).min(1).max(CANVAS_LIMITS.nodes),
    edges: z.array(CanvasEdgeSchema).max(CANVAS_LIMITS.edges).default([]),
    groups: z.array(CanvasGroupSchema).max(CANVAS_LIMITS.groups).default([]),
  })
  .superRefine((value, ctx) => {
    const nodeIds = new Set<string>();
    value.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          message: `E_DUP_NODE: 节点 id 重复 ${node.id}`,
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
    });

    const groupIds = new Set<string>();
    value.groups.forEach((group, index) => {
      if (groupIds.has(group.id)) {
        ctx.addIssue({
          code: "custom",
          message: `E_DUP_GROUP: 分组 id 重复 ${group.id}`,
          path: ["groups", index, "id"],
        });
      }
      groupIds.add(group.id);
    });

    value.nodes.forEach((node, index) => {
      if (node.groupId && !groupIds.has(node.groupId)) {
        ctx.addIssue({
          code: "custom",
          message: `E_GROUP_REF: 节点 ${node.id} 引用了不存在的分组 ${node.groupId}`,
          path: ["nodes", index, "groupId"],
        });
      }
    });

    const edgeIds = new Set<string>();
    value.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: "custom",
          message: `E_EDGE_FROM: 边起点不存在 ${edge.from}`,
          path: ["edges", index, "from"],
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          message: `E_EDGE_TO: 边终点不存在 ${edge.to}`,
          path: ["edges", index, "to"],
        });
      }
      if (edge.from === edge.to) {
        ctx.addIssue({
          code: "custom",
          message: `E_SELF_EDGE: 不允许自环 ${edge.from}`,
          path: ["edges", index],
        });
      }
      if (edge.id) {
        if (edgeIds.has(edge.id)) {
          ctx.addIssue({
            code: "custom",
            message: `E_DUP_EDGE_ID: 边 id 重复 ${edge.id}`,
            path: ["edges", index, "id"],
          });
        }
        edgeIds.add(edge.id);
      }
    });
  });

export type DeerCanvas = z.infer<typeof CanvasSchema>;
export type DeerCanvasNode = z.infer<typeof CanvasNodeSchema>;
export type DeerCanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type DeerCanvasGroup = z.infer<typeof CanvasGroupSchema>;

// ---------------------------------------------------------------------------
// Question schema（设计 §5.4）
// ---------------------------------------------------------------------------

const QuestionOptionSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(QUESTION_LIMITS.label),
  description: z.string().trim().max(QUESTION_LIMITS.optionDescription).optional(),
});

const fieldBase = {
  id: Id,
  label: z.string().trim().min(1).max(QUESTION_LIMITS.label),
  description: z.string().trim().max(QUESTION_LIMITS.optionDescription).optional(),
  required: z.boolean().default(true),
};

const SingleFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("single"),
  options: z.array(QuestionOptionSchema).min(2).max(QUESTION_LIMITS.options),
});

const MultiFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("multi"),
  options: z.array(QuestionOptionSchema).min(2).max(QUESTION_LIMITS.options),
  min: z.number().int().min(0).max(QUESTION_LIMITS.options).optional(),
  max: z.number().int().min(0).max(QUESTION_LIMITS.options).optional(),
});

const TextFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("text"),
  placeholder: z.string().trim().max(120).optional(),
  maxLength: z.number().int().min(1).max(QUESTION_LIMITS.textMaxLength).default(500),
  multiline: z.boolean().default(true),
});

const ConfirmFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("confirm"),
  danger: z.boolean().default(false),
});

export const QuestionFieldSchema = z.discriminatedUnion("kind", [
  SingleFieldSchema,
  MultiFieldSchema,
  TextFieldSchema,
  ConfirmFieldSchema,
]);

export const QuestionSchema = z
  .strictObject({
    protocol: z.literal(QUESTION_PROTOCOL),
    version: z.literal(QUESTION_VERSION),
    /** 仅用于展示/引用；真实问题 id 由 messageId + blockIndex 派生。 */
    id: z.string().trim().max(64).optional(),
    title: z.string().trim().min(1).max(QUESTION_LIMITS.title),
    description: z.string().trim().max(QUESTION_LIMITS.description).optional(),
    fields: z.array(QuestionFieldSchema).min(1).max(QUESTION_LIMITS.fields),
    /** 5–3600 秒；缺省表示不过期。 */
    timeoutSec: z.number().int().min(5).max(3600).optional(),
  })
  .superRefine((value, ctx) => {
    const fieldIds = new Set<string>();
    value.fields.forEach((field, index) => {
      if (fieldIds.has(field.id)) {
        ctx.addIssue({
          code: "custom",
          message: `E_DUP_FIELD: 字段 id 重复 ${field.id}`,
          path: ["fields", index, "id"],
        });
      }
      fieldIds.add(field.id);

      if (field.kind === "single" || field.kind === "multi") {
        const optionIds = new Set<string>();
        field.options.forEach((option, optionIndex) => {
          if (optionIds.has(option.id)) {
            ctx.addIssue({
              code: "custom",
              message: `E_DUP_OPTION: 选项 id 重复 ${option.id}`,
              path: ["fields", index, "options", optionIndex, "id"],
            });
          }
          optionIds.add(option.id);
        });
      }
      if (field.kind === "multi") {
        const min = field.min ?? 0;
        const max = field.max ?? field.options.length;
        if (min > max || max > field.options.length) {
          ctx.addIssue({
            code: "custom",
            message: "E_MULTI_RANGE: 多选 min/max 超出选项范围",
            path: ["fields", index],
          });
        }
      }
    });
  });

export type DeerQuestion = z.infer<typeof QuestionSchema>;
export type QuestionField = z.infer<typeof QuestionFieldSchema>;
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type SingleQuestionField = z.infer<typeof SingleFieldSchema>;
export type MultiQuestionField = z.infer<typeof MultiFieldSchema>;
export type TextQuestionField = z.infer<typeof TextFieldSchema>;
export type ConfirmQuestionField = z.infer<typeof ConfirmFieldSchema>;
export type QuestionValue = string | string[] | boolean;
export type QuestionValues = Record<string, QuestionValue>;
export type QuestionAnswers = { values: QuestionValues; answeredAt: string };

export type QuestionFieldErrorCode =
  | "required"
  | "unknown_field"
  | "invalid_type"
  | "invalid_option"
  | "too_few"
  | "too_many"
  | "too_long"
  | "invalid_value";

export interface QuestionFieldError {
  fieldId: string;
  code: QuestionFieldErrorCode;
  /** 面向用户的中文；不含模型原文中的 HTML。 */
  message: string;
}

// ---------------------------------------------------------------------------
// 错误模型（设计 §5.6 / 附录 B）
// ---------------------------------------------------------------------------

export type InteractiveErrorCode =
  | "E_JSON"
  | "E_SCHEMA"
  | "E_PROTOCOL"
  | "E_VERSION"
  | "E_TOO_LARGE"
  | "E_LIMIT"
  | "E_UNCLOSED";

export interface InteractiveError {
  code: InteractiveErrorCode;
  /** 面向用户的一句中文；不含模型原文中的潜在 HTML。 */
  message: string;
  /** 面向「查看详情」的首个错误路径/细节；纯文本。 */
  detail?: string;
}

export type InteractiveWarningCode =
  | "W_DUP_EDGE"
  | "W_CYCLE"
  | "W_ROOT"
  | "W_UNREACHABLE"
  | "W_EMPTY_GROUP"
  | "W_DENSITY";

export const INTERACTIVE_ERROR_TEXT: Record<InteractiveErrorCode, string> = {
  E_JSON: "交互块不是合法 JSON",
  E_SCHEMA: "包含不受支持的内容",
  E_PROTOCOL: "不是受支持的画布/表单",
  E_VERSION: "协议版本过新，请升级 DeerSuperGroup",
  E_TOO_LARGE: "交互块过大",
  E_LIMIT: "交互块超过数量上限",
  E_UNCLOSED: "交互块数据未完成",
};

function makeError(
  code: InteractiveErrorCode,
  detail?: string,
  message?: string,
): InteractiveError {
  return { code, message: message ?? INTERACTIVE_ERROR_TEXT[code], detail };
}

// ---------------------------------------------------------------------------
// 文本清洗（N03；设计 §8.3）
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BIDI_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const MAX_NOTE_LINES = 8;

/**
 * 清洗进入 UI/DB 的纯文本：去 C0 控制符（保留 \n\t 交给下游处理）、零宽与双向控制符。
 * - 单行文本：空白折叠为单空格；
 * - 多行文本（note/description）：保留换行，最多 8 行，每行折叠空白。
 */
export function sanitizeText(value: string, options: { multiline?: boolean } = {}): string {
  const cleaned = String(value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(/\r\n?/g, "\n");
  if (!options.multiline) {
    return cleaned.replace(/[\s\u00a0]+/g, " ").trim();
  }
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/[\s\u00a0]+/g, " ").trim())
    .slice(0, MAX_NOTE_LINES);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 归一化（N01–N08；设计 §5.6）
// ---------------------------------------------------------------------------

function normalizeOption(option: QuestionOption): QuestionOption {
  const next: QuestionOption = {
    id: option.id,
    label: sanitizeText(option.label),
  };
  if (option.description !== undefined) {
    next.description = sanitizeText(option.description);
  }
  return next;
}

function normalizeField(field: QuestionField): QuestionField {
  const description =
    field.description === undefined ? undefined : sanitizeText(field.description);
  if (field.kind === "single") {
    const next: QuestionField = {
      id: field.id,
      kind: "single",
      label: sanitizeText(field.label),
      required: field.required,
      options: field.options.map(normalizeOption),
    };
    if (description !== undefined) next.description = description;
    return next;
  }
  if (field.kind === "multi") {
    const next: QuestionField = {
      id: field.id,
      kind: "multi",
      label: sanitizeText(field.label),
      required: field.required,
      options: field.options.map(normalizeOption),
    };
    if (description !== undefined) next.description = description;
    if (field.min !== undefined) next.min = field.min;
    if (field.max !== undefined) next.max = field.max;
    return next;
  }
  if (field.kind === "text") {
    const next: QuestionField = {
      id: field.id,
      kind: "text",
      label: sanitizeText(field.label),
      required: field.required,
      maxLength: field.maxLength,
      multiline: field.multiline,
    };
    if (description !== undefined) next.description = description;
    if (field.placeholder !== undefined) next.placeholder = sanitizeText(field.placeholder);
    return next;
  }
  const next: QuestionField = {
    id: field.id,
    kind: "confirm",
    label: sanitizeText(field.label),
    required: field.required,
    danger: field.danger,
  };
  if (description !== undefined) next.description = description;
  return next;
}

export function normalizeQuestion(question: DeerQuestion): DeerQuestion {
  const next: DeerQuestion = {
    protocol: question.protocol,
    version: question.version,
    title: sanitizeText(question.title),
    fields: question.fields.map(normalizeField),
  };
  if (question.id !== undefined) next.id = sanitizeText(question.id);
  if (question.description !== undefined) {
    next.description = sanitizeText(question.description, { multiline: true });
  }
  if (question.timeoutSec !== undefined) next.timeoutSec = question.timeoutSec;
  return next;
}

export function defaultDirection(kind: CanvasKind): CanvasDirection {
  if (kind === "flowchart" || kind === "mindmap") return "TB";
  return "LR";
}

export function normalizeCanvas(canvas: DeerCanvas): {
  artifact: DeerCanvas;
  warnings: InteractiveWarningCode[];
} {
  const warnings: InteractiveWarningCode[] = [];
  const usedEdgeIds = new Set<string>();
  for (const edge of canvas.edges) {
    if (edge.id) usedEdgeIds.add(edge.id);
  }
  const seenEdges = new Set<string>();
  const edges: DeerCanvasEdge[] = [];
  let generated = 0;
  for (const edge of canvas.edges) {
    const dedupeKey = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (seenEdges.has(dedupeKey)) {
      warnings.push("W_DUP_EDGE");
      continue;
    }
    seenEdges.add(dedupeKey);
    let id = edge.id;
    if (!id) {
      generated += 1;
      let candidate = `e${generated}`;
      while (usedEdgeIds.has(candidate)) {
        generated += 1;
        candidate = `e${generated}`;
      }
      usedEdgeIds.add(candidate);
      id = candidate;
    }
    const next: DeerCanvasEdge = {
      id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
    };
    if (edge.label !== undefined) next.label = sanitizeText(edge.label);
    edges.push(next);
  }

  const nodes: DeerCanvasNode[] = canvas.nodes.map((node) => {
    const next: DeerCanvasNode = {
      id: node.id,
      label: sanitizeText(node.label),
      kind: node.kind,
      status: node.status,
    };
    if (node.note !== undefined) next.note = sanitizeText(node.note, { multiline: true });
    if (node.meta !== undefined) next.meta = sanitizeText(node.meta);
    if (node.groupId !== undefined) next.groupId = node.groupId;
    if (node.order !== undefined) next.order = node.order;
    if (node.refs !== undefined) next.refs = { ...node.refs };
    return next;
  });

  const groups: DeerCanvasGroup[] = canvas.groups.map((group) => {
    const next: DeerCanvasGroup = {
      id: group.id,
      label: sanitizeText(group.label),
    };
    if (group.order !== undefined) next.order = group.order;
    if (group.tone !== undefined) next.tone = group.tone;
    if (group.status !== undefined) next.status = group.status;
    return next;
  });

  const artifact: DeerCanvas = {
    protocol: canvas.protocol,
    version: canvas.version,
    kind: canvas.kind,
    title: sanitizeText(canvas.title),
    direction: canvas.direction ?? defaultDirection(canvas.kind),
    nodes,
    edges,
    groups,
  };
  if (canvas.summary !== undefined) {
    artifact.summary = sanitizeText(canvas.summary, { multiline: true });
  }
  return { artifact, warnings: Array.from(new Set(warnings)) };
}

// ---------------------------------------------------------------------------
// JSON 解析入口（设计 §5.3/§5.4/§5.7）
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { ok: true; value: T; warnings: InteractiveWarningCode[] }
  | { ok: false; error: InteractiveError };

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(root)";
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "未知校验错误";
  return `${issuePath(issue.path)} · ${issue.message}`;
}

function parseJsonObject(raw: string, label: string): ParseResult<Record<string, unknown>> {
  const text = raw.trim();
  if (!text) return { ok: false, error: makeError("E_JSON", `${label}内容为空`) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: makeError("E_JSON", message.slice(0, 200)) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: makeError("E_JSON", `${label}必须是单个 JSON 对象`),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown>, warnings: [] };
}

export function parseCanvasJson(raw: string): ParseResult<DeerCanvas> {
  if (byteLength(raw) > CANVAS_LIMITS.jsonBytes) {
    return {
      ok: false,
      error: makeError("E_TOO_LARGE", `画布原始数据 ${byteLength(raw)} 字节 > ${CANVAS_LIMITS.jsonBytes}`),
    };
  }
  const base = parseJsonObject(raw, "画布数据");
  if (!base.ok) return base;
  const object = base.value;
  if (object.protocol !== CANVAS_PROTOCOL) {
    return {
      ok: false,
      error: makeError("E_PROTOCOL", "protocol 不是 deer-canvas"),
    };
  }
  if (typeof object.version === "number" && object.version > CANVAS_VERSION) {
    return {
      ok: false,
      error: makeError("E_VERSION", `画布版本 ${object.version} > ${CANVAS_VERSION}`),
    };
  }
  const result = CanvasSchema.safeParse(object);
  if (!result.success) {
    return { ok: false, error: makeError("E_SCHEMA", firstIssue(result.error)) };
  }
  const normalized = normalizeCanvas(result.data);
  return { ok: true, value: normalized.artifact, warnings: normalized.warnings };
}

export function parseQuestionJson(raw: string): ParseResult<DeerQuestion> {
  if (byteLength(raw) > CANVAS_LIMITS.jsonBytes) {
    return {
      ok: false,
      error: makeError("E_TOO_LARGE", `表单原始数据 ${byteLength(raw)} 字节 > ${CANVAS_LIMITS.jsonBytes}`),
    };
  }
  const base = parseJsonObject(raw, "表单数据");
  if (!base.ok) return base;
  const object = base.value;
  if (object.protocol !== QUESTION_PROTOCOL) {
    return {
      ok: false,
      error: makeError("E_PROTOCOL", "protocol 不是 deer-question"),
    };
  }
  if (typeof object.version === "number" && object.version > QUESTION_VERSION) {
    return {
      ok: false,
      error: makeError("E_VERSION", `表单版本 ${object.version} > ${QUESTION_VERSION}`),
    };
  }
  const result = QuestionSchema.safeParse(object);
  if (!result.success) {
    return { ok: false, error: makeError("E_SCHEMA", firstIssue(result.error)) };
  }
  return { ok: true, value: normalizeQuestion(result.data), warnings: [] };
}

// ---------------------------------------------------------------------------
// Fence 扫描（设计 §5.2）
// ---------------------------------------------------------------------------

export type FenceKind = "canvas" | "question";

export type ScannedSegment =
  | { kind: "text"; text: string; start: number }
  | {
      kind: "interactive";
      fence: FenceKind;
      info: string;
      body: string;
      closed: boolean;
      start: number;
    };

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

function fenceKindOf(info: string): FenceKind | null {
  const normalized = info.trim().toLowerCase();
  if (normalized === "deer-canvas") return "canvas";
  if (normalized === "deer-question") return "question";
  return null;
}

/**
 * 把消息正文切成「文本段 / deer-* 交互块」。
 * - 其他代码块完全留在文本段中，交给现有 Markdown 渲染（不拦截）；
 * - 每段带起始字符偏移，供流式预览截断使用；
 * - 未闭合 fence 的 body 一直到文本结尾，closed=false。
 */
export function scanInteractiveSegments(content: string): ScannedSegment[] {
  const text = String(content ?? "");
  const lower = text.toLowerCase();
  if (!lower.includes("deer-canvas") && !lower.includes("deer-question")) {
    return [{ kind: "text", text, start: 0 }];
  }

  const segments: ScannedSegment[] = [];
  let textBuffer: string[] = [];
  let textStart = 0;
  let offset = 0;
  let index = 0;

  const flushText = (endOffset: number) => {
    if (textBuffer.length === 0) return;
    segments.push({ kind: "text", text: textBuffer.join("\n"), start: textStart });
    textBuffer = [];
    void endOffset;
  };

  while (index < text.length) {
    const lineEnd = text.indexOf("\n", offset);
    const nextOffset = lineEnd === -1 ? text.length : lineEnd + 1;
    const rawLine = text.slice(offset, lineEnd === -1 ? text.length : lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const open = FENCE_OPEN.exec(line);
    const fence = open ? fenceKindOf(open[3] ?? "") : null;

    if (open && fence) {
      flushText(offset);
      const fenceChar = open[2][0];
      const fenceLength = open[2].length;
      const bodyLines: string[] = [];
      let closed = false;
      let cursor = nextOffset;
      while (cursor < text.length) {
        const closeEnd = text.indexOf("\n", cursor);
        const closeNext = closeEnd === -1 ? text.length : closeEnd + 1;
        const closeRaw = text.slice(cursor, closeEnd === -1 ? text.length : closeEnd);
        const closeLine = closeRaw.endsWith("\r") ? closeRaw.slice(0, -1) : closeRaw;
        const close = FENCE_CLOSE.exec(closeLine);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
          closed = true;
          cursor = closeNext;
          break;
        }
        bodyLines.push(closeLine);
        cursor = closeNext;
      }
      segments.push({
        kind: "interactive",
        fence,
        info: (open[3] ?? "").trim(),
        body: bodyLines.join("\n"),
        closed,
        start: offset,
      });
      if (closed) {
        offset = cursor;
        textStart = cursor;
        index = cursor;
        continue;
      }
      // 未闭合：body 吃掉剩余全文。
      offset = text.length;
      index = text.length;
      break;
    }

    if (textBuffer.length === 0) textStart = offset;
    textBuffer.push(line);
    offset = nextOffset;
    index = nextOffset;
  }

  if (offset <= text.length && textBuffer.length > 0) {
    segments.push({ kind: "text", text: textBuffer.join("\n"), start: textStart });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 消息内容解析（设计 §3.2 / §5.7）
// ---------------------------------------------------------------------------

export interface ChatBlockMeta {
  /** 稳定键 `${messageId}#b${blockIndex}`（仅交互块有）。 */
  key: string;
  /** 消息内交互块序号（canvas/question 统一计数，从 0 开始）。 */
  blockIndex: number;
  raw: string;
}

export type ChatContentBlock =
  | { type: "text"; text: string }
  | ({ type: "canvas"; artifact: DeerCanvas; warnings: InteractiveWarningCode[] } & ChatBlockMeta)
  | ({ type: "canvas_error"; error: InteractiveError } & ChatBlockMeta)
  | ({ type: "question"; question: DeerQuestion } & ChatBlockMeta)
  | ({ type: "question_error"; error: InteractiveError } & ChatBlockMeta);

export interface ParseChatContentOptions {
  role?: "user" | "assistant" | "system";
  messageId?: string;
  /** false = 流式中间态（未闭合块视为「生成中」）；默认 true。 */
  complete?: boolean;
}

export function chatBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}#b${blockIndex}`;
}

export function parseChatContent(
  content: string,
  options: ParseChatContentOptions = {},
): ChatContentBlock[] {
  const role = options.role ?? "assistant";
  // 安全 §5.2 第 7 条：只解析助手消息；用户/系统消息一律纯文本（防伪造）。
  if (role !== "assistant") {
    return [{ type: "text", text: String(content ?? "") }];
  }
  const complete = options.complete ?? true;
  const segments = scanInteractiveSegments(content);
  const blocks: ChatContentBlock[] = [];
  const messageId = options.messageId ?? "local";
  let blockIndex = 0;
  let canvases = 0;
  let questions = 0;

  for (const segment of segments) {
    if (segment.kind === "text") {
      blocks.push({ type: "text", text: segment.text });
      continue;
    }
    const key = chatBlockKey(messageId, blockIndex);
    const meta: ChatBlockMeta = { key, blockIndex, raw: segment.body };
    blockIndex += 1;
    if (blockIndex > CANVAS_LIMITS.blocksPerMessage) {
      blocks.push({
        type: segment.fence === "canvas" ? "canvas_error" : "question_error",
        ...meta,
        error: makeError(
          "E_LIMIT",
          `一条消息最多 ${CANVAS_LIMITS.blocksPerMessage} 个交互块，当前第 ${blockIndex} 个`,
        ),
      });
      continue;
    }
    if (segment.fence === "canvas") {
      canvases += 1;
      if (canvases > CANVAS_LIMITS.canvasesPerMessage) {
        blocks.push({
          type: "canvas_error",
          ...meta,
          error: makeError("E_LIMIT", `一条消息最多 ${CANVAS_LIMITS.canvasesPerMessage} 个画布`),
        });
        continue;
      }
    } else {
      questions += 1;
      if (questions > CANVAS_LIMITS.questionsPerMessage) {
        blocks.push({
          type: "question_error",
          ...meta,
          error: makeError("E_LIMIT", `一条消息最多 ${CANVAS_LIMITS.questionsPerMessage} 个提问`),
        });
        continue;
      }
    }
    if (!segment.closed && complete) {
      blocks.push({
        type: segment.fence === "canvas" ? "canvas_error" : "question_error",
        ...meta,
        error: makeError("E_UNCLOSED"),
      });
      continue;
    }
    if (!segment.closed) {
      blocks.push({
        type: segment.fence === "canvas" ? "canvas_error" : "question_error",
        ...meta,
        error: makeError("E_UNCLOSED"),
      });
      continue;
    }
    if (segment.fence === "canvas") {
      const parsed = parseCanvasJson(segment.body);
      if (parsed.ok) {
        blocks.push({
          type: "canvas",
          ...meta,
          artifact: parsed.value,
          warnings: parsed.warnings,
        });
      } else {
        blocks.push({ type: "canvas_error", ...meta, error: parsed.error });
      }
    } else {
      const parsed = parseQuestionJson(segment.body);
      if (parsed.ok) {
        blocks.push({ type: "question", ...meta, question: parsed.value });
      } else {
        blocks.push({ type: "question_error", ...meta, error: parsed.error });
      }
    }
  }
  return blocks;
}

/** 快路径：正文没有任何 deer-* fence。 */
export function hasInteractiveFence(content: string): boolean {
  const lower = String(content ?? "").toLowerCase();
  return lower.includes("deer-canvas") || lower.includes("deer-question");
}

// ---------------------------------------------------------------------------
// 流式预览（设计 §7.1 / AC-31）
// ---------------------------------------------------------------------------

export interface StreamingPreview {
  text: string;
  pending: FenceKind | null;
}

/**
 * 流式预览只显示交互块之前的文本：
 * 一旦出现（含未闭合的）deer-* fence，就从预览中切除该 fence 及其后内容，
 * 由界面显示「正在生成画布/表单…」，避免半截 JSON 裸露。
 */
export function stripInteractiveForStreaming(content: string): StreamingPreview {
  const segments = scanInteractiveSegments(content);
  const firstInteractive = segments.find((segment) => segment.kind === "interactive");
  if (!firstInteractive || firstInteractive.kind !== "interactive") {
    return { text: String(content ?? ""), pending: null };
  }
  const prefix = segments
    .filter((segment): segment is Extract<ScannedSegment, { kind: "text" }> => {
      return segment.kind === "text" && segment.start < firstInteractive.start;
    })
    .map((segment) => segment.text)
    .join("\n");
  return { text: prefix, pending: firstInteractive.fence };
}

// ---------------------------------------------------------------------------
// 历史压缩（设计 §5.9）
// ---------------------------------------------------------------------------

export const MODEL_BLOCK_LIMIT = 16 * 1024;

export function compressInteractiveForModel(content: string, messageId: string): string {
  if (!hasInteractiveFence(content)) return content;
  const blocks = parseChatContent(content, { role: "assistant", messageId, complete: true });
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "canvas") {
      parts.push(
        `[画布「${block.artifact.title}」kind=${block.artifact.kind} ${block.artifact.nodes.length} 节点/${block.artifact.edges.length} 边 id=${block.key}]`,
      );
    } else if (block.type === "canvas_error") {
      parts.push(`[画布：数据无效（${block.error.code}），未渲染]`);
    } else if (block.type === "question") {
      parts.push(`[表单提问「${block.question.title}」${block.question.fields.length} 字段 id=${block.key}]`);
    } else {
      parts.push(`[表单提问：数据无效（${block.error.code}）]`);
    }
  }
  const compressed = parts.join("");
  return compressed.length > MODEL_BLOCK_LIMIT
    ? `${compressed.slice(0, MODEL_BLOCK_LIMIT)}…`
    : compressed;
}

// ---------------------------------------------------------------------------
// 答案校验与格式化（设计 §5.4 / §6.5 / §6.6）
// ---------------------------------------------------------------------------

function fieldError(
  fieldId: string,
  code: QuestionFieldErrorCode,
  message: string,
): QuestionFieldError {
  return { fieldId, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionLabels(field: SingleQuestionField | MultiQuestionField): Map<string, string> {
  return new Map(field.options.map((option) => [option.id, option.label]));
}

export function validateQuestionAnswers(
  question: DeerQuestion,
  input: unknown,
):
  | { ok: true; values: QuestionValues }
  | { ok: false; errors: QuestionFieldError[] } {
  const errors: QuestionFieldError[] = [];
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [fieldError("", "invalid_type", "回答必须是一个对象")],
    };
  }
  const known = new Set(question.fields.map((field) => field.id));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      errors.push(fieldError(key, "unknown_field", `未知字段：${key}`));
    }
  }
  // 显式构建值对象，避免 __proto__ / constructor 注入。
  const values: QuestionValues = Object.create(null) as QuestionValues;

  for (const field of question.fields) {
    const raw = input[field.id];
    if (field.kind === "single") {
      if (raw === undefined || raw === null || raw === "") {
        if (field.required) errors.push(fieldError(field.id, "required", `「${field.label}」为必填`));
        continue;
      }
      if (typeof raw !== "string") {
        errors.push(fieldError(field.id, "invalid_type", `「${field.label}」必须是单个选项`));
        continue;
      }
      if (!optionLabels(field).has(raw)) {
        errors.push(fieldError(field.id, "invalid_option", `「${field.label}」的选项无效`));
        continue;
      }
      values[field.id] = raw;
      continue;
    }
    if (field.kind === "multi") {
      const list = raw === undefined || raw === null ? [] : raw;
      if (!Array.isArray(list)) {
        errors.push(fieldError(field.id, "invalid_type", `「${field.label}」必须是选项数组`));
        continue;
      }
      if (field.required && list.length === 0) {
        errors.push(fieldError(field.id, "required", `「${field.label}」至少选择 1 项`));
        continue;
      }
      const labels = optionLabels(field);
      const seen = new Set<string>();
      let invalid = false;
      for (const item of list) {
        if (typeof item !== "string" || !labels.has(item) || seen.has(item)) {
          invalid = true;
          break;
        }
        seen.add(item);
      }
      if (invalid) {
        errors.push(fieldError(field.id, "invalid_option", `「${field.label}」包含无效选项`));
        continue;
      }
      const min = field.min ?? 0;
      const max = field.max ?? field.options.length;
      if (list.length < min) {
        errors.push(fieldError(field.id, "too_few", `「${field.label}」至少选择 ${min} 项`));
        continue;
      }
      if (list.length > max) {
        errors.push(fieldError(field.id, "too_many", `「${field.label}」最多选择 ${max} 项`));
        continue;
      }
      // 归一化顺序：按 options 定义顺序输出。
      const ordered = field.options
        .filter((option) => seen.has(option.id))
        .map((option) => option.id);
      values[field.id] = ordered;
      continue;
    }
    if (field.kind === "text") {
      if (raw === undefined || raw === null) {
        if (field.required) errors.push(fieldError(field.id, "required", `「${field.label}」为必填`));
        continue;
      }
      if (typeof raw !== "string") {
        errors.push(fieldError(field.id, "invalid_type", `「${field.label}」必须是文本`));
        continue;
      }
      const value = field.multiline
        ? sanitizeText(raw, { multiline: true })
        : sanitizeText(raw);
      if (!value && field.required) {
        errors.push(fieldError(field.id, "required", `「${field.label}」为必填`));
        continue;
      }
      if (value.length > field.maxLength) {
        errors.push(
          fieldError(field.id, "too_long", `「${field.label}」最多 ${field.maxLength} 字`),
        );
        continue;
      }
      values[field.id] = value;
      continue;
    }
    // confirm
    if (raw === undefined || raw === null) {
      if (field.required) errors.push(fieldError(field.id, "required", `「${field.label}」需要选择`));
      continue;
    }
    if (typeof raw !== "boolean") {
      errors.push(fieldError(field.id, "invalid_type", `「${field.label}」必须是布尔值`));
      continue;
    }
    values[field.id] = raw;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, values };
}

function answerTextForField(field: QuestionField, value: QuestionValue | undefined): string {
  if (field.kind === "single") {
    if (typeof value !== "string") return "（未回答）";
    return field.options.find((option) => option.id === value)?.label ?? "（未回答）";
  }
  if (field.kind === "multi") {
    const list = Array.isArray(value) ? value : [];
    if (list.length === 0) return "（空）";
    const labels = field.options
      .filter((option) => list.includes(option.id))
      .map((option) => option.label);
    return labels.length ? labels.join("、") : "（未回答）";
  }
  if (field.kind === "text") {
    const text = typeof value === "string" ? value : "";
    if (!text) return "（空）";
    const lines = text.split("\n");
    if (lines.length === 1) return text;
    return `\n${lines.map((line) => `  ${line}`).join("\n")}`;
  }
  if (typeof value !== "boolean") return "（未回答）";
  return value ? "确认" : "不确认";
}

/** 已回答摘要：按 question.fields 顺序输出 label/value（纯文本）。 */
export function questionAnswerLines(
  question: DeerQuestion,
  values: QuestionValues,
): Array<{ label: string; value: string }> {
  return question.fields.map((field) => ({
    label: field.label,
    value: answerTextForField(field, values[field.id]),
  }));
}

/** 回答回流格式（设计 §6.5）：`[回答表单] <title>` + 每个字段一行。 */
export function formatQuestionAnswer(question: DeerQuestion, values: QuestionValues): string {
  const lines = [`[回答表单] ${question.title}`, ""];
  for (const line of questionAnswerLines(question, values)) {
    lines.push(`- ${line.label}：${line.value}`);
  }
  let text = lines.join("\n");
  if (text.length > 8 * 1024) text = `${text.slice(0, 8 * 1024)}…`;
  return text;
}

/** 问题过期时间：assistant 消息创建时间 + timeoutSec；无 timeoutSec 返回 null。 */
export function questionExpiresAt(createdAt: string, timeoutSec?: number): string | null {
  if (!timeoutSec) return null;
  const base = Date.parse(createdAt);
  if (!Number.isFinite(base)) return null;
  return new Date(base + timeoutSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// 系统提示（设计 §5.8）
// ---------------------------------------------------------------------------

export const INTERACTIVE_PROMPT_V1 = [
  "## 交互协议 v1（deer-canvas / deer-question）",
  "",
  "当你需要画图或向用户提问时，在回复中插入 fenced JSON 块；否则不要使用。",
  "",
  "画布：",
  "```deer-canvas",
  '{"protocol":"deer-canvas","version":1,"kind":"flowchart","title":"标题","nodes":[{"id":"a","label":"节点 A","kind":"step","status":"planned"},{"id":"b","label":"节点 B","kind":"step","status":"planned"}],"edges":[{"from":"a","to":"b","kind":"flow"}]}',
  "```",
  "",
  "提问：",
  "```deer-question",
  '{"protocol":"deer-question","version":1,"title":"需要确认的问题","fields":[{"id":"choice","kind":"single","label":"选项","required":true,"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]}',
  "```",
  "",
  "规则：",
  "- kind 只能是 mindmap / flowchart / roadmap / dependency；node kind 只能是 root/topic/step/task/milestone/note/decision/risk；edge kind 只能是 flow/depends/contains/relates；status 只能是 planned/active/blocked/review/done/failed/cancelled。",
  "- 不输出 HTML、CSS、JS、颜色、坐标、尺寸、URL；节点/分组/选项 id 用 ASCII 字母、数字、`_`、`-`（1–64 字符）且唯一；边端点必须存在；标题/标签用纯文本。",
  "- 上限：画布 ≤80 节点、≤240 边、≤12 分组；提问 ≤6 字段；一次回复最多 3 个画布 + 3 个提问。",
  "- 只问真正影响下一步的决策；不要问密码/密钥/令牌；不要用提问代替系统的高风险操作审批。",
  "- 用户的回答会以「[回答表单]」开头的普通消息出现；不要假装用户已经回答。",
].join("\n");

// ---------------------------------------------------------------------------
// 展示用中文文案（组件复用；避免第二份映射）
// ---------------------------------------------------------------------------

export const CANVAS_KIND_LABEL: Record<CanvasKind, string> = {
  mindmap: "思维导图",
  flowchart: "流程图",
  roadmap: "路线图",
  dependency: "依赖图",
};

export const CANVAS_STATUS_LABEL: Record<CanvasStatus, string> = {
  planned: "计划中",
  active: "进行中",
  blocked: "阻塞",
  review: "待评审",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 状态双编码（颜色不是唯一通道）：形状/符号标记。 */
export const CANVAS_STATUS_MARK: Record<CanvasStatus, string> = {
  planned: "○",
  active: "◐",
  blocked: "▮",
  review: "◇",
  done: "✓",
  failed: "✕",
  cancelled: "⊘",
};

export const NODE_KIND_LABEL: Record<CanvasNodeKind, string> = {
  root: "核心",
  topic: "主题",
  step: "步骤",
  task: "任务",
  milestone: "里程碑",
  note: "注记",
  decision: "决策",
  risk: "风险",
};

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  flow: "流程",
  depends: "依赖",
  contains: "包含",
  relates: "关联",
};

export const GROUP_TONE_LABEL: Record<GroupTone, string> = {
  accent: "蓝",
  purple: "紫",
  green: "绿",
  yellow: "黄",
  red: "红",
  neutral: "灰",
};

export const QUESTION_KIND_LABEL: Record<QuestionField["kind"], string> = {
  single: "单选",
  multi: "多选",
  text: "文本",
  confirm: "确认",
};

/** 交互块耗时上限（主进程/渲染层共用的诊断常量，不在 UI 展示）。 */
export const INTERACTIVE_MAX_BLOCKS_PER_MESSAGE = CANVAS_LIMITS.blocksPerMessage;
