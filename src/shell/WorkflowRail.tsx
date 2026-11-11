import { useEffect, useRef, useState } from "react";
import {
  WORKFLOW_STAGES,
  type NeedsMeItem,
  type WorkflowProjection,
  type WorkflowStage,
} from "./workflowData";

/**
 * P0-3：工作区内常驻的轻量阶段条。
 * 不新增任务/事件源；只接收 workflowData 的纯投影。
 * 每阶段一个可点击入口；当前阶段额外显示唯一 CTA 文案。
 */
export default function WorkflowRail({
  projection,
  needs,
  onStage,
  onNeedsMe,
}: {
  projection: WorkflowProjection;
  needs: readonly NeedsMeItem[];
  onStage: (stage: WorkflowStage, taskId: string | null) => void;
  onNeedsMe: (item: NeedsMeItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <section className="workflow-rail" aria-label="工作流阶段">
      <nav className="workflow-stages" aria-label="讨论到记忆的工作流">
        {WORKFLOW_STAGES.map((stage) => {
          const current = projection.stage === stage.id;
          const cta = current ? projection.cta : null;
          return (
            <button
              key={stage.id}
              type="button"
              className={`workflow-stage ${current ? "is-current" : ""}`}
              aria-current={current ? "step" : undefined}
              onClick={() => onStage(stage.id, current ? projection.focusTaskId : null)}
              title={cta ? `${stage.label}：${cta.label}` : `${stage.label}：${stage.hint}`}
            >
              <span className="workflow-stage-label">{stage.label}</span>
              <span className="workflow-stage-hint">{cta ? cta.label : stage.hint}</span>
            </button>
          );
        })}
      </nav>

      {projection.stage === "unknown" ? (
        <span className="workflow-unknown muted tiny" role="status">
          阶段未知
        </span>
      ) : null}

      {needs.length > 0 ? (
        <div className="workflow-needs-wrap" ref={wrapRef}>
          <button
            type="button"
            className="workflow-needs"
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={() => setOpen((value) => !value)}
          >
            需要我处理
            <span className="workflow-needs-badge">{needs.length}</span>
          </button>
          {open ? (
            <div className="workflow-needs-popover" role="listbox" aria-label="需要我处理">
              {needs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  className={`workflow-needs-item is-${item.kind}`}
                  onClick={() => {
                    setOpen(false);
                    onNeedsMe(item);
                  }}
                >
                  <span className="workflow-needs-title">{item.title}</span>
                  <span className="workflow-needs-detail muted tiny">{item.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
