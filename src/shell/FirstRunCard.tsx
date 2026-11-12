import type { FirstRunState } from "./firstRunData.js";

export default function FirstRunCard({
  state,
  collapsed,
  onToggle,
  onAction,
}: {
  state: FirstRunState;
  collapsed: boolean;
  onToggle: () => void;
  onAction: () => void;
}) {
  if (collapsed) {
    return (
      <button type="button" className="first-run-collapsed" onClick={onToggle}>
        首用就绪检查
        <span className="muted tiny">
          {state.ready ? "已就绪" : `${state.checks.filter((check) => !check.ok).length} 项待处理`}
        </span>
      </button>
    );
  }

  return (
    <section className="first-run-card" aria-label="首用就绪">
      <div className="first-run-head">
        <div>
          <div className="panel-title">开始使用</div>
          <div className="muted tiny">
            {state.workspaceName || "当前工作区"} · {state.workspacePath || "尚未打开"}
          </div>
        </div>
        <button type="button" className="ghost tiny" onClick={onToggle}>
          稍后
        </button>
      </div>
      <ul className="first-run-checks" aria-label="就绪清单">
        {state.checks.map((check) => (
          <li key={check.key} className={check.ok ? "is-ok" : "is-missing"}>
            <span aria-hidden="true">{check.ok ? "✓" : "!"}</span>
            <strong>{check.label}</strong>
            <span className="muted tiny">{check.detail}</span>
          </li>
        ))}
      </ul>
      <div className="first-run-foot">
        <span className={state.ready ? "first-run-ready" : "first-run-blocked"} role="status">
          {state.ready ? "可以开始" : "还差一步即可开始"}
        </span>
        <button type="button" className="primary small" onClick={onAction}>
          {state.action.label}
        </button>
      </div>
    </section>
  );
}
