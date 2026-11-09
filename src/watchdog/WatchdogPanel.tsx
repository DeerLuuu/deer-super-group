import type {
  CostSnapshot,
  RunHandoff,
  WatchdogAlert,
  WatchdogSnapshot,
} from "../shared/watchdog.js";

function severityLabel(severity: WatchdogAlert["severity"]): string {
  return severity === "critical" ? "严重" : severity === "warning" ? "警告" : "提示";
}

export function BudgetBar({
  spentUsd,
  limitUsd,
  ratio,
  softRatio,
  label,
  onOpen,
}: {
  spentUsd: number;
  limitUsd: number;
  ratio: number;
  softRatio: number;
  label: string;
  onOpen?: () => void;
}) {
  const percent = Math.min(100, Math.round(ratio * 100));
  const state = limitUsd <= 0 ? "unset" : ratio >= 1 ? "hard" : ratio >= softRatio ? "soft" : "ok";
  const text =
    limitUsd <= 0
      ? "预算未设置"
      : `${label}已用 ${percent}%，$${spentUsd.toFixed(2)} / $${limitUsd.toFixed(2)}`;
  return (
    <button
      type="button"
      className={`watchdog-budget watchdog-budget-${state}`}
      onClick={onOpen}
      aria-label={text}
    >
      <span className="watchdog-budget-label">{limitUsd <= 0 ? "预算未设置" : `$${spentUsd.toFixed(2)}`}</span>
      <span
        className="watchdog-budget-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limitUsd <= 0 ? 0 : percent}
        aria-valuetext={text}
      >
        <span className="watchdog-budget-fill" style={{ width: `${limitUsd <= 0 ? 0 : percent}%` }} />
      </span>
      <span className="watchdog-budget-text">{text}</span>
    </button>
  );
}

export function WatchdogAlertBanner({
  alert,
  onAck,
  onResolve,
  onRelease,
}: {
  alert: WatchdogAlert;
  onAck?: (alert: WatchdogAlert) => void;
  onResolve?: (alert: WatchdogAlert) => void;
  onRelease?: (alert: WatchdogAlert) => void;
}) {
  const critical = alert.severity === "critical";
  return (
    <section
      className={`watchdog-alert watchdog-alert-${alert.severity}`}
      role={critical ? "alert" : "status"}
      aria-live={critical ? "assertive" : "polite"}
      data-alert-id={alert.id}
    >
      <div className="watchdog-alert-head">
        <span className="watchdog-alert-icon" aria-hidden="true">
          {critical ? "!" : "i"}
        </span>
        <strong>{severityLabel(alert.severity)}</strong>
        <span>{alert.title}</span>
      </div>
      <p className="muted tiny">
        {alert.taskId ? `任务 ${alert.taskId}` : ""} {alert.runId ? `· Run ${alert.runId}` : ""}
      </p>
      <div className="row gap wrap">
        {onAck && alert.status === "open" && (
          <button type="button" className="ghost tiny" onClick={() => onAck(alert)}>
            确认告警
          </button>
        )}
        {onResolve && alert.status !== "resolved" && (
          <button type="button" className="ghost tiny" onClick={() => onResolve(alert)}>
            标记已解决
          </button>
        )}
        {onRelease && alert.taskId && (
          <button type="button" className="ghost tiny" onClick={() => onRelease(alert)}>
            恢复任务
          </button>
        )}
      </div>
    </section>
  );
}

export function RunHandoffCard({ handoff }: { handoff: RunHandoff }) {
  return (
    <article className="watchdog-handoff" aria-label={`Run ${handoff.runId} 交接摘要`}>
      <header className="row gap wrap">
        <strong>交接摘要</strong>
        <span className="muted tiny">
          {handoff.reason} · attempt {handoff.attempt}
        </span>
      </header>
      <p className="watchdog-handoff-summary">{handoff.summary}</p>
      <dl className="watchdog-handoff-fields">
        <div>
          <dt>下一步</dt>
          <dd>{handoff.nextStep}</dd>
        </div>
        <div>
          <dt>变更文件</dt>
          <dd>{handoff.files.length ? handoff.files.join("、") : "无"}</dd>
        </div>
      </dl>
      {handoff.diffStat && (
        <details>
          <summary>Diff 统计</summary>
          <pre className="mono tiny">{handoff.diffStat}</pre>
        </details>
      )}
    </article>
  );
}

export function WatchdogPanel({
  snapshot,
  costs,
  onAck,
  onResolve,
  onRelease,
  onOpenRun,
}: {
  snapshot: WatchdogSnapshot;
  costs: CostSnapshot | null;
  onAck?: (alert: WatchdogAlert) => void;
  onResolve?: (alert: WatchdogAlert) => void;
  onRelease?: (alert: WatchdogAlert) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const openAlerts = snapshot.alerts.filter((alert) => alert.status !== "resolved");
  const critical = openAlerts.find((alert) => alert.severity === "critical");
  return (
    <section className="watchdog-panel" aria-label="看门狗面板">
      <header className="watchdog-panel-head">
        <h2>看门狗</h2>
        <span className="muted tiny">{snapshot.enabled ? "已启用" : "已停用"}</span>
        {snapshot.deadman && <span className="pill pill-failed">心跳中断</span>}
        {snapshot.pausedBy && <span className="pill">暂停：{snapshot.pausedBy}</span>}
      </header>
      {critical && (
        <WatchdogAlertBanner alert={critical} onAck={onAck} onResolve={onResolve} onRelease={onRelease} />
      )}
      <div className="watchdog-panel-section" aria-live="polite">
        <h3>告警</h3>
        {openAlerts.length === 0 ? (
          <p className="muted tiny">看门狗运行正常</p>
        ) : (
          <ul className="watchdog-alert-list">
            {openAlerts.map((alert) => (
              <li key={alert.id}>
                <WatchdogAlertBanner
                  alert={alert}
                  onAck={onAck}
                  onResolve={onResolve}
                  onRelease={onRelease}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="watchdog-panel-section">
        <h3>干预与降级</h3>
        {snapshot.interventions.length === 0 ? (
          <p className="muted tiny">未发生自动干预</p>
        ) : (
          <ul className="watchdog-intervention-list">
            {snapshot.interventions.map((item) => (
              <li key={item.id}>
                <strong>{item.level}</strong> · {item.reason} · {item.status}
                {item.handoffId && (
                  <button type="button" className="ghost tiny" onClick={() => onOpenRun?.(item.runId ?? "")}>
                    查看交接
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {snapshot.holds.length > 0 && (
          <p className="muted tiny">
            暂停原因：{snapshot.holds.map((hold) => `${hold.reason}(${hold.scope})`).join("、")}
          </p>
        )}
      </div>
      <div className="watchdog-panel-section">
        <h3>成本</h3>
        <BudgetBar
          spentUsd={snapshot.budgets.workspaceDay.spentUsd}
          limitUsd={snapshot.budgets.workspaceDay.limitUsd}
          ratio={snapshot.budgets.workspaceDay.ratio}
          softRatio={snapshot.budgets.softRatio}
          label="今日预算"
        />
        {!snapshot.budgets.pricingKnown && <p className="muted tiny">未配置模型价格，成本为估算/未知</p>}
        {costs && (
          <p className="muted tiny">
            今日 ${costs.totals.usd.toFixed(4)} · {costs.totals.runs} 个 Run
            {costs.recent[0] && ` · 最近 $${costs.recent[0].costUsd.toFixed(4)}`}
          </p>
        )}
        {snapshot.fallback.models.length > 0 && (
          <p className="muted tiny">降级链：{snapshot.fallback.models.join(" → ")}</p>
        )}
      </div>
    </section>
  );
}
