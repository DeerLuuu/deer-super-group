import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConsoleError, ConsoleSession, ConsoleStatus } from "../../shared/console.js";
import type { ConsoleStore } from "./consoleStore.js";
import {
  useConsoleMeta,
  useConsoleOutput,
  useConsoleSelected,
} from "./consoleHooks.js";
import { formatConsoleDuration } from "./BackgroundTasksPopover.js";

const RUNNING: ConsoleStatus[] = ["starting", "running", "stopping"];

function statusLabel(status: ConsoleStatus): string {
  switch (status) {
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

function isRunning(session: ConsoleSession | null): boolean {
  return Boolean(session && RUNNING.includes(session.status));
}

function tailLines(value: string): string {
  const lines = value.split("\n");
  return lines.length <= 2000 ? value : lines.slice(-2000).join("\n");
}

function startErrorMessage(error: ConsoleError): string {
  return error.message || "启动失败";
}

export function ConsolePanel({
  store,
  workspaceId,
}: {
  store: ConsoleStore;
  workspaceId: string;
}) {
  const meta = useConsoleMeta(store);
  const selected = useConsoleSelected(store);
  const output = useConsoleOutput(store, selected?.id ?? null);
  const [command, setCommand] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState(".");
  const [cwds, setCwds] = useState<string[]>(["."]);
  const [newTab, setNewTab] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stdin, setStdin] = useState("");
  const [confirm, setConfirm] = useState<{
    token: string;
    reasons: string[];
    command: string;
    cwd: string;
    title: string;
  } | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const stickRef = useRef(true);
  const commandRef = useRef<HTMLTextAreaElement | null>(null);
  const panelId = useId();

  const visible = store.visibleSessions();
  const running = isRunning(selected);
  const stdinMode = running && !newTab;

  useEffect(() => {
    let alive = true;
    void store.cwds().then((next) => {
      if (alive && next.length) setCwds(next);
    });
    return () => {
      alive = false;
    };
  }, [store, workspaceId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (stickRef.current) node.scrollTop = node.scrollHeight;
  }, [output?.output, selected?.id]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setNewTab(false);
  }, [selected?.id]);

  async function startCommand(
    inputCommand = command,
    inputCwd = cwd,
    inputTitle = title,
    confirmToken?: string,
  ): Promise<void> {
    const text = inputCommand.trim();
    if (!text) {
      setError("请输入要运行的命令");
      return;
    }
    setError(null);
    const result = await store.start({
      command: text,
      cwd: inputCwd,
      title: inputTitle.trim() || undefined,
      confirmToken,
    });
    if (!result) {
      setError("控制台不可用");
      return;
    }
    if (!result.ok) {
      if (result.error.code === "CONSOLE_CONFIRM_REQUIRED") {
        const details = result.error.details ?? {};
        const token = typeof details.confirmToken === "string" ? details.confirmToken : "";
        const reasons = Array.isArray(details.reasons)
          ? details.reasons.filter((item): item is string => typeof item === "string")
          : [];
        if (token) {
          setConfirm({ token, reasons, command: text, cwd: inputCwd, title: inputTitle });
          return;
        }
      }
      setError(startErrorMessage(result.error));
      return;
    }
    setCommand("");
    setTitle("");
    setStdin("");
    setNewTab(false);
    setConfirm(null);
    setNotice("已启动");
  }

  async function onSendStdin(): Promise<void> {
    if (!selected || !stdinMode) {
      await startCommand();
      return;
    }
    if (!stdin) return;
    const result = await store.input(selected.id, `${stdin}\n`);
    if (result && !result.ok) setError(result.error.message);
    else {
      setStdin("");
      setError(null);
    }
  }

  async function onStop(): Promise<void> {
    if (!selected) return;
    const result = await store.stop(selected.id);
    if (result && !result.ok) setError(result.error.message);
  }

  async function onRestart(): Promise<void> {
    if (!selected) return;
    await startCommand(selected.command, selected.cwdRelative, selected.title);
  }

  async function onClear(): Promise<void> {
    if (!selected) return;
    const result = await store.clear(selected.id);
    if (result && !result.ok) setError(result.error.message);
  }

  async function onCopy(): Promise<void> {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(output?.output ?? "");
      setNotice("已复制");
      setError(null);
    } catch {
      setError("复制失败，请手动选择输出");
    }
  }

  async function closeTab(session: ConsoleSession): Promise<void> {
    if (RUNNING.includes(session.status)) {
      const confirmed =
        typeof window.confirm === "function"
          ? window.confirm(`「${session.title}」仍在运行，停止并关闭？`)
          : false;
      if (!confirmed) return;
    }
    await store.close(session.id);
  }

  function selectRelative(delta: number): void {
    if (visible.length === 0) return;
    const index = visible.findIndex((session) => session.id === selected?.id);
    const next = visible[(index + delta + visible.length) % visible.length];
    if (next) void store.select(next.id);
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectRelative(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectRelative(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (visible[0]) void store.select(visible[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = visible[visible.length - 1];
      if (last) void store.select(last.id);
    }
  }

  const visibleOutput = useMemo(() => tailLines(output?.output ?? ""), [output?.output]);
  const metaError = meta?.error?.message ?? null;

  return (
    <section className="panel console-panel" aria-label="命令控制台">
      <div className="panel-head console-head">
        <div className="panel-title">控制台</div>
        <div className="muted tiny">后台运行 · 关闭面板不停止任务</div>
      </div>

      <div className="console-tabbar" role="tablist" aria-label="控制台标签" onKeyDown={onTabKeyDown}>
        <div className="console-tabs-scroll">
          {visible.map((session) => {
            const active = session.id === selected?.id;
            return (
              <div
                key={session.id}
                role="tab"
                id={`console-tab-${session.id}`}
                aria-controls={`console-panel-output`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={`console-tab${active ? " active" : ""}`}
                onClick={() => void store.select(session.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setNewTab(false);
                    void store.select(session.id);
                  }
                }}
              >
                <span className={`console-status-dot ${session.status}`} aria-hidden="true" />
                <span className="console-tab-title">{session.title}</span>
                <button
                  type="button"
                  className="console-tab-close"
                  aria-label={`关闭 ${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(session);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="console-tab-add"
            aria-label="新建控制台"
            title="新建命令"
            onClick={() => {
              setCommand("");
              setTitle("");
              setCwd(".");
              setNewTab(true);
              setError(null);
              setConfirm(null);
              if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(() => commandRef.current?.focus());
              } else {
                commandRef.current?.focus();
              }
            }}
          >
            +
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="console-empty">
          <p>还没有控制台任务</p>
          <p className="muted tiny">运行 dev server、测试或日志命令；关闭面板不会停止它们。</p>
        </div>
      ) : null}

      {selected && (
        <div className="console-toolbar">
          <div className="console-command" title={selected.command}>
            <code>{selected.command}</code>
          </div>
          <div className="console-meta">
            <span>{statusLabel(selected.status)}</span>
            <span>{formatConsoleDuration(selected)}</span>
            {selected.exitCode !== null && <span>exit {selected.exitCode}</span>}
            {selected.truncated && <span>仅尾部</span>}
            <span className="muted">cwd {selected.cwdRelative}</span>
          </div>
          <div className="row gap console-actions">
            <button
              type="button"
              className="ghost tiny"
              onClick={() => void onStop()}
              disabled={!running}
              title={running ? "停止任务" : "任务未运行"}
            >
              停止
            </button>
            <button type="button" className="ghost tiny" onClick={() => void onRestart()}>
              重启
            </button>
            <button type="button" className="ghost tiny" onClick={() => void onClear()}>
              清屏
            </button>
            <button type="button" className="ghost tiny" onClick={() => void onCopy()}>
              复制
            </button>
          </div>
        </div>
      )}

      {(error ?? metaError) && (
        <div className="console-error" role="alert">
          {error ?? metaError}
        </div>
      )}
      {notice && <div className="console-notice role-status" role="status">{notice}</div>}

      <pre
        ref={scrollRef}
        id="console-panel-output"
        className="console-output"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="控制台输出"
        tabIndex={0}
        data-truncated={output?.truncated ? "1" : "0"}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
      >
        {visibleOutput || "暂无输出"}
      </pre>
      {output?.truncated && (
        <div className="console-truncated muted tiny">
          输出已截断{output.droppedBytes > 0 ? `，丢弃 ${Math.ceil(output.droppedBytes / 1024)} KB` : ""}；仅显示尾部
        </div>
      )}

      {confirm && (
        <div className="console-confirm" role="alertdialog" aria-label="确认危险命令">
          <div className="console-confirm-title">确认运行可能破坏数据的命令？</div>
          <code>{confirm.command}</code>
          {confirm.reasons.length > 0 && (
            <ul>
              {confirm.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="muted tiny">这是人类安全确认，不是沙箱；命令将以当前用户权限运行。</p>
          <div className="row gap">
            <button
              type="button"
              className="primary small"
              onClick={() =>
                void startCommand(confirm.command, confirm.cwd, confirm.title, confirm.token)
              }
            >
              确认并启动
            </button>
            <button type="button" className="ghost small" onClick={() => setConfirm(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="console-composer">
        <label className="sr-only" htmlFor={`${panelId}-command`}>
          {stdinMode ? "控制台输入" : "运行命令"}
        </label>
        {stdinMode ? (
          <textarea
            id={`${panelId}-command`}
            aria-label="控制台输入"
            className="console-input"
            value={stdin}
            placeholder="输入 stdin，Enter 发送，Shift+Enter 换行"
            onChange={(event) => setStdin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSendStdin();
              }
            }}
          />
        ) : (
          <textarea
            id={`${panelId}-command`}
            ref={commandRef}
            aria-label="运行命令"
            className="console-input"
            value={command}
            placeholder="输入命令并启动，例如 pnpm dev"
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSendStdin();
              }
            }}
          />
        )}
        {!stdinMode && (
          <div className="console-new-options">
            <label>
              cwd
              <select aria-label="工作目录" value={cwd} onChange={(event) => setCwd(event.target.value)}>
                {cwds.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              标题
              <input
                aria-label="任务标题"
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="可选"
              />
            </label>
          </div>
        )}
        <div className="row gap console-send-row">
          <span className="muted tiny">
            {stdinMode ? "stdin · Enter 发送" : "手动执行 · Agent 不会自动运行"}
          </span>
          <button type="button" className="primary small" onClick={() => void onSendStdin()}>
            {stdinMode ? "发送" : "启动"}
          </button>
        </div>
      </div>
    </section>
  );
}
