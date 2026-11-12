import type { ExecutionContract } from "./executionContract.js";

/** P1-5：任务头只读执行契约；模型/权限 chip 只导航到现有设置或团队编辑。 */
export function TaskContractChips({
  contract,
  fullThrottle,
  onOpenModels,
  onEditOwner,
}: {
  contract: ExecutionContract;
  fullThrottle: boolean;
  onOpenModels: () => void;
  onEditOwner: (ownerId: string | null) => void;
}) {
  return (
    <div className="task-contract-chips" role="group" aria-label="执行契约（只读）">
      <button
        type="button"
        className="task-contract-chip"
        onClick={onOpenModels}
        aria-label={`模型：${contract.model}。打开设置模型`}
        title="只读契约：模型来自负责人；点击打开设置 > 模型"
      >
        <span className="task-contract-chip-label">模型</span>
        <span>{contract.model}</span>
      </button>
      <button
        type="button"
        className="task-contract-chip"
        onClick={() => onEditOwner(contract.ownerId)}
        aria-label={`权限：${contract.permissionLabel}。在团队中编辑负责人`}
        title="只读契约：权限来自负责人；点击在团队中编辑该成员"
      >
        <span className="task-contract-chip-label">权限</span>
        <span>{contract.permissionLabel}</span>
        {contract.permission !== "未知" ? (
          <span className="muted tiny mono">({contract.permission})</span>
        ) : null}
      </button>
      <span
        className={`task-contract-chip ${fullThrottle ? "is-on" : ""}`}
        title="Full Throttle 为 Router 会话级提示/预算模式，不改变工具权限"
      >
        <span className="task-contract-chip-label">FT</span>
        <span>{contract.fullThrottle}</span>
      </span>
      <span
        className="task-contract-chip"
        title="任务头只显示当前 trace 数量；更多 > 查看上下文打开上下文面板"
      >
        <span className="task-contract-chip-label">上下文</span>
        <span>{contract.context}</span>
      </span>
    </div>
  );
}
