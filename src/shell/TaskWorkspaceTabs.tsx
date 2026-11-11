import type { KeyboardEvent } from "react";
import {
  TASK_WORKSPACE_TABS,
  taskWorkspacePanelId,
  taskWorkspaceTabForKey,
  type TaskWorkspaceTab,
} from "./taskWorkspaceData.js";

export default function TaskWorkspaceTabs({
  tab,
  onChange,
  counts,
}: {
  tab: TaskWorkspaceTab;
  onChange: (tab: TaskWorkspaceTab) => void;
  counts?: Partial<Record<TaskWorkspaceTab, number>>;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = taskWorkspaceTabForKey(tab, event.key);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    const target = event.currentTarget.querySelector<HTMLElement>(
      `[data-task-tab="${next}"]`,
    );
    target?.focus();
  }

  return (
    <div
      className="task-workspace-tabs"
      role="tablist"
      aria-label="任务工作区"
      onKeyDown={onKeyDown}
    >
      {TASK_WORKSPACE_TABS.map((item) => {
        const count = counts?.[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`task-tab-${item.id}`}
            data-task-tab={item.id}
            aria-selected={tab === item.id}
            aria-controls={taskWorkspacePanelId(item.id)}
            tabIndex={tab === item.id ? 0 : -1}
            className={`task-workspace-tab ${tab === item.id ? "is-active" : ""}`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {typeof count === "number" && count > 0 ? (
              <span className="task-tab-count" aria-label={`${count} 项`}>
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
