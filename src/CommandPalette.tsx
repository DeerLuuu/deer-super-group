import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "./shared/types";
import type { RouteTab } from "./shared/deeplink";
import { TASK_STATUS_LABEL } from "./shared/copy";

/**
 * C11 全局搜索 / 命令面板（Ctrl/⌘+K）。
 * 单一命令注册表：导航 6 项 + 新建 5 项 + 当前快照实体（任务/成员/邮件/黑板）。
 * ↑↓ 选择、Enter 执行、Esc 关闭；空查询时显示导航与新建命令。
 */

export type CreateIntent = "task" | "plan" | "mail" | "board" | "member";

/** t50：dock 面板命令（面板组）。 */
export type PanelAction =
  | "open-context"
  | "close-active"
  | "reset-layout"
  | "reset-all"
  | "move-left"
  | "move-right"
  | "move-up"
  | "move-down"
  | "open-merge-queue"
  | "open-git-settings"
  | "open-task-vcs";

type PaletteAction = {
  id: string;
  group: "导航" | "新建" | "面板" | "任务" | "成员" | "邮件" | "黑板" | "Git";
  label: string;
  hint?: string;
  run: () => void;
};

export const CREATE_LABELS: Record<CreateIntent, string> = {
  task: "新建任务",
  plan: "规划任务（Router 拆解目标）",
  mail: "发邮件",
  board: "发布黑板条目",
  member: "新建成员",
};

/** C11：创建动作的落位 tab（弹窗在目标页内打开）。 */
export const CREATE_TARGET_TAB: Record<CreateIntent, RouteTab> = {
  task: "tasks",
  plan: "tasks",
  mail: "mailbox",
  board: "board",
  member: "team",
};

export default function CommandPalette({
  snapshot,
  onClose,
  onNavigate,
  onOpenTask,
  onOpenMessage,
  onOpenBoard,
  onCreate,
  onPanelAction,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onNavigate: (tab: RouteTab) => void;
  onOpenTask: (taskId: string) => void;
  onOpenMessage: (messageId: string) => void;
  onOpenBoard: (board: string) => void;
  onCreate: (intent: CreateIntent) => void;
  onPanelAction?: (action: PanelAction) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const navTabs: Array<{ id: RouteTab; label: string; hint: string }> = [
    { id: "tasks", label: "任务", hint: "任务列表、规划与 trace" },
    { id: "team", label: "团队", hint: "进度、成员与星图" },
    { id: "chat", label: "对话", hint: "与 Router 讨论、上下文" },
    { id: "mailbox", label: "邮箱", hint: "团队内部消息" },
    { id: "board", label: "黑板", hint: "领域共享记忆" },
    { id: "settings", label: "设置", hint: "模型与运行配置" },
  ];

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    navTabs.forEach((item, index) => {
      list.push({
        id: `nav-${item.id}`,
        group: "导航",
        label: `前往 ${item.label}`,
        hint: `Alt+${index + 1} · ${item.hint}`,
        run: () => onNavigate(item.id),
      });
    });
    (Object.keys(CREATE_LABELS) as CreateIntent[]).forEach((intent) => {
      list.push({
        id: `create-${intent}`,
        group: "新建",
        label: CREATE_LABELS[intent],
        run: () => onCreate(intent),
      });
    });
    if (onPanelAction) {
      const panelCommands: Array<{ id: PanelAction; label: string; hint: string }> = [
        { id: "open-context", label: "打开 上下文面板", hint: "对话的上下文可视化" },
        { id: "close-active", label: "关闭当前面板", hint: "Ctrl+Alt+W · 设置面板不可关闭" },
        { id: "move-left", label: "移动当前面板：向左", hint: "Ctrl+Shift+Alt+←" },
        { id: "move-right", label: "移动当前面板：向右", hint: "Ctrl+Shift+Alt+→" },
        { id: "move-up", label: "移动当前面板：向上", hint: "Ctrl+Shift+Alt+↑" },
        { id: "move-down", label: "移动当前面板：向下", hint: "Ctrl+Shift+Alt+↓" },
        { id: "reset-layout", label: "恢复默认布局", hint: "对话 + 团队双主面板" },
        { id: "reset-all", label: "重置所有布局（当前工作区）", hint: "清除全部已保存布局" },
      ];
      for (const command of panelCommands) {
        list.push({
          id: `panel-${command.id}`,
          group: "面板",
          label: command.label,
          hint: command.hint,
          run: () => onPanelAction(command.id),
        });
      }
      const gitCommands: Array<{ id: PanelAction; label: string; hint: string }> = [
        { id: "open-merge-queue", label: "打开 合并队列", hint: "#/tasks?merge=1 · 串行合并与检查" },
        { id: "open-git-settings", label: "打开 Git 设置", hint: "#/settings?git=1 · 仓库/分支/PR 配置" },
        { id: "open-task-vcs", label: "打开 当前任务 Git 状态", hint: "#/tasks?t=&vcs=1 · 分支/PR/检查/合并" },
      ];
      for (const command of gitCommands) {
        list.push({
          id: `git-${command.id}`,
          group: "Git",
          label: command.label,
          hint: command.hint,
          run: () => onPanelAction(command.id),
        });
      }
    }
    for (const task of snapshot.tasks) {
      list.push({
        id: `task-${task.id}`,
        group: "任务",
        label: task.title,
        hint: `${TASK_STATUS_LABEL[task.status]} · ${task.id}`,
        run: () => onOpenTask(task.id),
      });
    }
    for (const agent of snapshot.agents) {
      list.push({
        id: `agent-${agent.id}`,
        group: "成员",
        label: agent.name,
        hint: agent.role + (agent.isRouter ? " · Router" : ""),
        run: () => onNavigate("team"),
      });
    }
    for (const message of snapshot.messages) {
      list.push({
        id: `message-${message.id}`,
        group: "邮件",
        label: message.subject,
        hint: `${message.from} → ${message.to.join(", ")}`,
        run: () => onOpenMessage(message.id),
      });
    }
    const boards = [...new Set(snapshot.boardEntries.map((entry) => entry.board))];
    for (const board of boards) {
      list.push({
        id: `board-${board}`,
        group: "黑板",
        label: board,
        hint: `${snapshot.boardEntries.filter((entry) => entry.board === board).length} 条`,
        run: () => onOpenBoard(board),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, onNavigate, onOpenTask, onOpenMessage, onOpenBoard, onCreate, onPanelAction]);

  const keyword = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!keyword) {
      return actions.filter(
        (action) =>
          action.group === "导航" ||
          action.group === "新建" ||
          action.group === "面板" ||
          action.group === "Git",
      );
    }
    return actions.filter((action) =>
      `${action.label} ${action.hint ?? ""}`.toLowerCase().includes(keyword),
    );
  }, [actions, keyword]);

  const clamped = Math.min(active, Math.max(0, results.length - 1));

  function run(action: PaletteAction | undefined) {
    if (!action) return;
    action.run();
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % Math.max(1, results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(
        (current) =>
          (current - 1 + Math.max(1, results.length)) % Math.max(1, results.length),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[clamped]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  let lastGroup = "";

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索与命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索任务 / 成员 / 邮件 / 黑板，或输入命令…"
          aria-label="搜索或命令"
          aria-activedescendant={results[clamped] ? `palette-item-${results[clamped].id}` : undefined}
        />
        <div className="palette-list" role="listbox" aria-label="结果">
          {results.length === 0 && (
            <div className="empty small">没有匹配「{query.trim()}」的结果。</div>
          )}
          {results.map((action, index) => {
            const header = action.group !== lastGroup ? action.group : null;
            lastGroup = action.group;
            return (
              <div key={action.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  type="button"
                  id={`palette-item-${action.id}`}
                  role="option"
                  aria-selected={index === clamped}
                  className={`palette-item ${index === clamped ? "active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(action)}
                >
                  <span className="palette-item-label ellipsis">{action.label}</span>
                  {action.hint && <span className="muted tiny ellipsis">{action.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot muted tiny">
          ↑↓ 选择 · Enter 执行 · Esc 关闭 · Alt+1–6 切换页面 · Ctrl+Shift+Alt+方向键 移动面板 ·
          Ctrl+Shift+Alt+[ ] 调宽
        </div>
      </div>
    </div>
  );
}
