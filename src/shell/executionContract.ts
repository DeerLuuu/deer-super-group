import type { Agent, Task } from "../shared/types.js";
import { PERMISSION_LABELS } from "../shared/copy.js";

export type ExecutionContract = {
  ownerId: string | null;
  ownerName: string;
  model: string;
  permission: string;
  permissionLabel: string;
  fullThrottle: "开启（会话级）" | "关闭（会话级）";
  context: string;
  source: "owner" | "unassigned" | "unavailable";
};

/**
 * P1-5：任务头执行契约只读投影。来源仅现有 task.ownerId + agents + 会话 FT；
 * 不猜测未知值：无 owner → 未知，owner 无 model → 默认模型。
 */
export function taskExecutionContract(
  task: Pick<Task, "id" | "ownerId"> | null,
  agents: readonly Agent[],
  fullThrottle: boolean,
  traceCount: number,
): ExecutionContract {
  const owner = task?.ownerId ? agents.find((agent) => agent.id === task.ownerId) : null;
  return {
    ownerId: owner?.id ?? task?.ownerId ?? null,
    ownerName: owner?.name ?? (task?.ownerId ? "负责人不可用" : "未分配"),
    model: owner ? owner.model?.trim() || "默认模型" : "未知",
    permission: owner?.permission ?? "未知",
    permissionLabel: owner ? PERMISSION_LABELS[owner.permission] ?? owner.permission : "未知",
    fullThrottle: fullThrottle ? "开启（会话级）" : "关闭（会话级）",
    context: traceCount > 0 ? `trace ${traceCount} 条` : "无 trace",
    source: owner ? "owner" : task?.ownerId ? "unavailable" : "unassigned",
  };
}
