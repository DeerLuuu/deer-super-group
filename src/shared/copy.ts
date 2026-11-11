import { sanitizeErrorText } from "./errorRedaction.js";
import type {
  AgentStatus,
  BoardKind,
  KernelErrorCode,
  MessageKind,
  PermissionMode,
  RunStatus,
  TaskStatus,
} from "./types";

/**
 * C01 状态与枚举统一：全应用唯一的状态/类型中文映射。
 * 任何展示状态或类型文案的地方都必须引用这里，禁止再建第二份映射。
 */

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  ready: "待运行",
  queued: "排队中",
  running: "进行中",
  blocked: "等待依赖",
  review: "评审中",
  done: "已交付",
  failed: "失败",
  cancelled: "已取消",
};

/** t69：Run 状态中文文案（与 TaskStatus 分开，避免「review/completed」混用）。 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_human: "等待人工",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** t69：Task.blockedReason 文案；未知值原样返回。 */
export const BLOCKED_REASON_LABEL: Record<string, string> = {
  waiting_dependencies: "等待上游依赖完成",
  dependency_failed: "上游任务失败，依赖无法满足",
  dependency_cancelled: "上游任务已取消",
  manual: "手动阻塞",
};

/** t69：Task.failureKind / Run.errorCode 常见文案；未知值原样返回。 */
export const FAILURE_KIND_LABEL: Record<string, string> = {
  retry_exhausted: "自动重试已耗尽",
  REVIEW_REJECTED: "评审拒绝",
  RUN_CANCELLED: "Run 被取消",
  LEASE_EXPIRED: "租约过期",
  RUN_TIMEOUT: "Run 超时",
  RISK_DENIED: "高风险操作被拒绝",
  RISK_TIMEOUT: "高风险审批超时",
  ORPHANED: "孤儿 Run 回收",
  DUPLICATE_ACTIVE: "重复活跃 Run",
  NO_AVAILABLE_AGENT: "没有可用成员",
  INTERNAL: "内部错误",
};

/** t69：内核命令错误码中文前缀（稳定错误码，UI 不解析 message）。 */
export const KERNEL_ERROR_LABEL: Record<KernelErrorCode, string> = {
  INVALID_TRANSITION: "状态不允许此操作",
  INVALID_DEPENDENCY: "依赖不满足",
  DEPENDENCY_LOCKED: "依赖被锁定",
  NOT_FOUND: "对象不存在",
  CONFLICT: "并发冲突，请刷新后重试",
  PAUSED: "调度器已暂停",
  LIMIT_REACHED: "已达到并发上限",
  NO_AVAILABLE_AGENT: "没有可用成员",
  HOOK_REJECTED: "调度前置检查拒绝",
  IDEMPOTENT_REPLAY: "重复命令已忽略",
  INTERNAL: "内核内部错误",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "空闲",
  running: "进行中",
  blocked: "阻塞",
  offline: "离线",
};

export const MESSAGE_KIND_LABEL: Record<MessageKind, string> = {
  request: "请求",
  report: "汇报",
  question: "提问",
  decision: "决策",
  artifact: "产物",
  review: "评审",
};

export const BOARD_KIND_LABEL: Record<BoardKind, string> = {
  fact: "事实",
  decision: "决策",
  question: "问题",
  warning: "警告",
  artifact: "产物",
  link: "链接",
};

export const BOARD_CONFIDENCE_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "置信度低",
  medium: "置信度中",
  high: "置信度高",
};

/** DESIGN §15.2 权限模式中文文案（对话控制条与成员编辑共用）。 */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  read_only: "仅查看",
  workspace_write: "工作区内修改",
  full_access: "完全权限",
  auto_risk: "自动风险投票",
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  read_only: "只读：读文件/搜索/看任务黑板邮箱，拒绝一切写入与 shell",
  workspace_write: "工作区内读写，shell 仅限只读命令（git status/ls/cat 等）",
  full_access: "全部工具（含任意 shell），高风险动作仍写审计事件",
  auto_risk: "低风险自动放行；中风险快速评审投票；高风险必须人类确认",
};

export const PERMISSION_MODES: PermissionMode[] = [
  "read_only",
  "workspace_write",
  "full_access",
  "auto_risk",
];

/** 任意状态（任务/成员）取中文文案；未知值原样返回。 */
export function statusLabel(status: string): string {
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_LABEL, status)) {
    return TASK_STATUS_LABEL[status as TaskStatus];
  }
  if (Object.prototype.hasOwnProperty.call(AGENT_STATUS_LABEL, status)) {
    return AGENT_STATUS_LABEL[status as AgentStatus];
  }
  return status;
}

/**
 * C26 错误文案模板：去掉 Electron IPC 的
 * "Error invoking remote method <name>:" 前缀，把底层原文留给「复制详情」。
 */
const REMOTE_METHOD_PREFIX =
  /^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/i;

export function formatError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const stripped = text.replace(REMOTE_METHOD_PREFIX, "").trim();
  return sanitizeErrorText(stripped || text);
}
