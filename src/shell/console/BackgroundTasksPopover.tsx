import { useEffect, useId, useRef, useState } from "react";
import type { ConsoleSession } from "../../shared/console.js";
import type { ConsoleStore } from "./consoleStore.js";
import { useConsoleSessions } from "./consoleHooks.js";

function statusLabel(session: ConsoleSession): string {
  switch (session.status) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "stopping":
      return "停止中";
    case "exited":
      return "已完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
  }
}

export function formatConsoleDuration(session: ConsoleSession): string {
  const start = Date.parse(session.startedAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

export function BackgroundTasksButton({
  store,
  onOpenConsole,
}: {
  store: ConsoleStore;
  onOpenConsole: (sessionId?: string) => void;
}) {
  const sessions = useConsoleSessions(store);
  const running = sessions.filter((session) =>
    ["starting", "running", "stopping"].includes(session.status),
  ).length;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= sessions.length) setActiveIndex(Math.max(0, sessions.length - 1));
  }, [activeIndex, sessions.length]);

  function openPanel(sessionId?: string) {
    setOpen(false);
    onOpenConsole(sessionId);
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
    if (event.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(sessions.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      const session = sessions[activeIndex];
      if (session) {
        event.preventDefault();
        openPanel(session.id);
      }
    }
  }

  return (
    <div className="background-tasks">
      <button
        ref={triggerRef}
        type="button"
        className="ghost tiny background-tasks-trigger"
        aria-label={`后台任务，${running} 个运行中`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        title="后台任务：查看运行中与最近命令"
      >
        后台任务
        {running > 0 && <span className="background-tasks-badge">{running}</span>}
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={listId}
          className="background-tasks-popover"
          role="dialog"
          aria-label="后台任务列表"
        >
          <div className="background-tasks-head">
            <span>后台任务</span>
            <button
              type="button"
              className="background-tasks-open ghost tiny"
              onClick={() => openPanel()}
            >
              打开命令控制台
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="background-tasks-empty">
              <p>没有后台任务</p>
              <button type="button" className="primary small" onClick={() => openPanel()}>
                打开命令控制台
              </button>
            </div>
          ) : (
            <div
              className="background-tasks-list"
              role="listbox"
              aria-label="后台任务"
              onKeyDown={onListKeyDown}
            >
              {sessions.map((session, index) => (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`background-task-item${index === activeIndex ? " active" : ""}`}
                  onClick={() => openPanel(session.id)}
                  onFocus={() => setActiveIndex(index)}
                >
                  <span className={`console-status-dot ${session.status}`} aria-hidden="true" />
                  <span className="background-task-text">
                    <span className="background-task-title">{session.title}</span>
                    <span className="background-task-command">{session.command}</span>
                    <span className="background-task-meta">
                      {session.cwdRelative} · {statusLabel(session)}
                      {session.status === "exited" || session.status === "failed"
                        ? ` · exit ${session.exitCode ?? "?"}`
                        : ` · ${formatConsoleDuration(session)}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
