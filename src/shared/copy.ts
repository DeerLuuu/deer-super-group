import type { AgentStatus, BoardKind, MessageKind, PermissionMode, TaskStatus } from "./types";

/**
 * C01 状态与枚举统一：全应用唯一的状态/类型中文映射。
 * 任何展示状态或类型文案的地方都必须引用这里，禁止再建第二份映射。
 */

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  ready: "待运行",
  running: "进行中",
  blocked: "等待依赖",
  review: "评审中",
  done: "已交付",
  failed: "失败",
  cancelled: "已取消",
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
  return stripped || text;
}
