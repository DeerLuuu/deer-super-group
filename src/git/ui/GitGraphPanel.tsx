import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutGraph } from "../graph.js";
import "./gitGraph.css";
import "./gitSourceTree.css";
import { GitDiffViewer } from "./GitDiffViewer.js";
import {
  SECTION_RATIO_DEFAULT,
  SECTION_RATIO_MAX,
  SECTION_RATIO_MIN,
  attachSectionDrag,
  ratioAfterKey,
} from "./gitWorkingLayout.js";
import type {
  GitCommitDetail,
  GitDiffPage,
  GitGraphPage,
  GitReadRef,
  GitReadRepo,
  GitReadWorktree,
  GitWorkingFile,
  GitWorkingStatus,
} from "../readTypes.js";
import type { GitIgnorePreview } from "../writeTypes.js";
import type { GitResult } from "../types.js";
import type { GitInitProbe } from "../initTypes.js";
import { GitInitModal } from "./GitInitModal.js";
import Modal from "../../Modal.js";
import {
  GIT_WS_DEFAULT,
  GIT_WS_MIN,
  clampWorkspaceHeight,
  loadWorkspaceHeight,
  maxWorkspaceHeight,
  saveWorkspaceHeight,
  splitterUsable,
  workspaceHeightAfterKey,
  workspaceHeightFromPointer,
  workspaceHeightStyle,
} from "./gitWorkspaceSplit.js";

type Api = NonNullable<Window["deer"]>;

/** t389：按 workspaceId 记忆最后视图，Dock 视口切换重挂面板后恢复（防暂存上下文丢失）。 */
const lastViewByWorkspace = new Map<string, "graph" | "detail" | "workspace">();

function unwrap<T>(result: GitResult<T>): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(`${result.errorCode ?? "GIT_READ_INTERNAL"}: ${result.message ?? "read failed"}`);
  }
  return result.value;
}

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "—";
}

function statusLabel(file: GitWorkingFile): string {
  return file.status || "?";
}

export default function GitGraphPanel({
  workspaceId,
  initialSha,
}: {
  workspaceId: string;
  initialSha?: string | null;
}) {
  const api = typeof window !== "undefined" ? (window as unknown as { deer?: Api }).deer : undefined;
  const [repo, setRepo] = useState<GitReadRepo | null>(null);
  const [graph, setGraph] = useState<GitGraphPage | null>(null);
  const [refs, setRefs] = useState<GitReadRef[]>([]);
  const [worktrees, setWorktrees] = useState<GitReadWorktree[]>([]);
  const [selectedSha, setSelectedSha] = useState<string | null>(initialSha ?? null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [working, setWorking] = useState<GitWorkingStatus | null>(null);
  const [workingDiff, setWorkingDiff] = useState<GitDiffPage | null>(null);
  // t389 走查修复：Dock 在视口切换（wide/single 变体往返）时会重挂本面板，
  // view 状态丢失导致用户暂存上下文消失。按 workspaceId 记忆最后视图，
  // 重挂时恢复到离开前的 tab。
  const [view, setView] = useState<"graph" | "detail" | "workspace">(
    () => lastViewByWorkspace.get(workspaceId) ?? "graph",
  );
  const [filter, setFilter] = useState("");
  const [authorSearch, setAuthorSearch] = useState("");
  const [jumpSha, setJumpSha] = useState("");
  const [sortMode, setSortMode] = useState<"topology" | "date">("topology");
  const [fileFilter, setFileFilter] = useState("");
  const [fileSort, setFileSort] = useState<"path" | "status">("path");
  const [compactFiles, setCompactFiles] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<"diff" | "commit">("commit");
  const [navFocus, setNavFocus] = useState<"history" | "files" | "search">("history");
  const [navOpen, setNavOpen] = useState(false);
  const [refSearch, setRefSearch] = useState("");
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const commitSearchRef = useRef<HTMLInputElement | null>(null);
  const [refFilter, setRefFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initProbe, setInitProbe] = useState<GitInitProbe | null>(null);
  const [initOpen, setInitOpen] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [initSuccess, setInitSuccess] = useState(false);
  // t352 G1：写闭环状态（stage/unstage/commit/.gitignore）。
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [lastCommitSha, setLastCommitSha] = useState<string | null>(null);
  const [ignorePreviewData, setIgnorePreviewData] = useState<GitIgnorePreview | null>(null);
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreBusy, setIgnoreBusy] = useState(false);

  // 提交成功提示 8 秒后自动消失，避免残留旧信息。
  useEffect(() => {
    if (!lastCommitSha) return;
    const timer = setTimeout(() => setLastCommitSha(null), 8_000);
    return () => clearTimeout(timer);
  }, [lastCommitSha]);
  const requestRef = useRef(0);
  const commitRequestRef = useRef(0);
  const tabRefs = useRef<Record<"graph" | "detail" | "workspace", HTMLButtonElement | null>>({
    graph: null,
    detail: null,
    workspace: null,
  });
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // t432（G9）：历史/工作区水平分隔条——工作区高度状态 + 容器高度观察（resize 时重新 clamp）。
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [workspaceHeight, setWorkspaceHeight] = useState(() =>
    loadWorkspaceHeight(workspaceId),
  );

  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setContainerHeight(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 容器高度变化（窗口/面板 resize）→ 重新 clamp 当前高度。
  useEffect(() => {
    if (!splitterUsable(containerHeight)) return;
    setWorkspaceHeight((prev) => {
      const next = clampWorkspaceHeight(prev, containerHeight);
      return next === prev ? prev : next;
    });
  }, [containerHeight]);

  function commitWorkspaceHeight(next: number) {
    const clamped = clampWorkspaceHeight(next, containerHeight);
    setWorkspaceHeight(clamped);
    saveWorkspaceHeight(workspaceId, clamped);
  }

  function onSplitterPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const container = layoutRef.current;
    if (!container) return;
    const move = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      commitWorkspaceHeight(workspaceHeightFromPointer(rect.height, moveEvent.clientY - rect.top));
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  }

  function onSplitterKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const keyMap = {
      ArrowUp: true,
      ArrowDown: true,
      Home: true,
      End: true,
    } as const;
    if (!(event.key in keyMap)) return;
    event.preventDefault();
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      commitWorkspaceHeight(
        workspaceHeightAfterKey(
          workspaceHeight,
          event.key as "ArrowUp" | "ArrowDown" | "Home" | "End",
          containerHeight,
        ),
      );
    }
  }

  const loadCommit = useCallback(
    async (sha: string) => {
      if (!api) return;
      const token = ++commitRequestRef.current;
      try {
        const value = unwrap(await api.gitCommit(workspaceId, sha));
        if (token !== commitRequestRef.current) return;
        setDetail(value);
        setSelectedSha(sha);
      } catch (cause) {
        if (token !== commitRequestRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, workspaceId],
  );

  const load = useCallback(
    async (ref: string | null = refFilter, sha = selectedSha) => {
      if (!api) return;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      setInitError(null);
      try {
        const probe = api.gitInitProbe ? await api.gitInitProbe(workspaceId) : null;
        if (request !== requestRef.current) return;
        setInitProbe(probe);
        if (probe && probe.status !== "already-repo") {
          setLoading(false);
          return;
        }
        const [repoResult, graphResult, refsResult] = await Promise.all([
          api.gitRepo(workspaceId),
          api.gitGraph(workspaceId, { limit: 200, offset: 0, ...(ref ? { ref } : {}) }),
          api.gitRefs(workspaceId, 500),
        ]);
        if (request !== requestRef.current) return;
        const repoValue = unwrap(repoResult);
        const graphValue = unwrap(graphResult);
        const refsValue = unwrap(refsResult);
        setRepo(repoValue);
        setGraph(graphValue);
        setRefs(refsValue.refs);
        setWorktrees(refsValue.worktrees);
        const nextSha =
          sha && graphValue.commits.some((commit) => commit.sha === sha)
            ? sha
            : graphValue.commits[0]?.sha ?? null;
        if (nextSha) await loadCommit(nextSha);
        else setDetail(null);
      } catch (cause) {
        if (request === requestRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [api, workspaceId, refFilter, selectedSha, loadCommit],
  );

  useEffect(() => {
    void load(null, initialSha ?? null);
    void loadWorking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // t389：重挂时若恢复的是「工作区」视图，需主动拉取工作区状态（selectView 不会再触发）。
  useEffect(() => {
    if (lastViewByWorkspace.get(workspaceId) === "workspace") void loadWorking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const loadMore = async () => {
    if (!api || !graph || graph.nextOffset == null || busy) return;
    setBusy(true);
    try {
      const next = unwrap(await api.gitGraph(workspaceId, { limit: 500, offset: graph.nextOffset, ...(refFilter ? { ref: refFilter } : {}) }));
      const combined = [...graph.commits, ...next.commits];
      const rows = layoutGraph({ commits: combined, maxLanes: 16 });
      const laid = combined.map((commit, index) => ({
        ...commit,
        lane: rows.rows[index]?.lane ?? 0,
        color: rows.rows[index]?.color ?? 0,
        parentLanes: rows.rows[index]?.parentLanes ?? [],
        openEdges: rows.rows[index]?.openEdges ?? [],
      }));
      setGraph({ ...next, commits: laid, totalLoaded: combined.length, truncated: next.truncated || rows.truncatedLanes });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadWorking = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      setWorking(unwrap(await api.gitStatus(workspaceId)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  function selectView(next: "graph" | "detail" | "workspace", focus = false) {
    setView(next);
    lastViewByWorkspace.set(workspaceId, next);
    if (next === "workspace") void loadWorking();
    if (focus) tabRefs.current[next]?.focus();
  }

  function openCommit(sha: string) {
    setSelectedSha(sha);
    setJumpSha(sha);
    setInspectorMode("commit");
    setWorkingDiff(null);
    setView("graph");
    void loadCommit(sha);
  }

  function onTabKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const order = ["graph", "detail", "workspace"] as const;
    const index = order.indexOf(view);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;
    event.preventDefault();
    selectView(order[next], true);
  }

  const openWorkingFile = async (file: GitWorkingFile) => {
    if (!api) return;
    setBusy(true);
    try {
      const scope = file.staged ? "staged" as const : "working" as const;
      setWorkingDiff(unwrap(await api.gitDiff(workspaceId, { scope, path: file.path, context: 3 })));
      setInspectorMode("diff");
      // t401：选择文件即展示 Diff；480 下同时切到 Diff tab。
      setView("detail");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // t352 G1：写操作统一入口——失败保留 inline 错误（可重试），成功后刷新状态与图。
  const runWrite = useCallback(
    async (fn: () => Promise<GitResult<unknown> | undefined>, opts?: { reloadGraph?: boolean }) => {
      if (!api || writeBusy) return;
      setWriteBusy(true);
      setWriteError(null);
      try {
        const result = await fn();
        if (result && !result.ok) {
          setWriteError(`${result.message ?? result.errorCode}`);
          return;
        }
        await loadWorking();
        if (opts?.reloadGraph !== false) {
          await load(null, selectedSha);
        }
      } catch (cause) {
        setWriteError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setWriteBusy(false);
      }
    },
    [api, writeBusy, load, loadWorking, selectedSha],
  );

  const handleStage = useCallback(
    (paths: string[]) => {
      if (!api?.gitStage || paths.length === 0) return;
      // t389 走查修复：stage 只影响工作区状态，不改变提交图；
      // 重载整图会长时间阻塞写按钮（writeBusy >1 分钟），故仅刷新 status。
      void runWrite(() => api.gitStage!(workspaceId, paths), { reloadGraph: false });
    },
    [api, runWrite, workspaceId],
  );

  const handleUnstage = useCallback(
    (paths: string[]) => {
      if (!api?.gitUnstage || paths.length === 0) return;
      // t389 走查修复：同 stage——unstage 不改图，只刷新工作区状态。
      void runWrite(() => api.gitUnstage!(workspaceId, paths), { reloadGraph: false });
    },
    [api, runWrite, workspaceId],
  );

  const handleCommit = useCallback(
    async (title: string, body: string) => {
      if (!api?.gitCreateCommit) return;
      await runWrite(async () => {
        const result = await api.gitCreateCommit!(workspaceId, title, body || undefined);
        if (result.ok && result.value) setLastCommitSha(result.value.sha);
        return result;
      });
    },
    [api, runWrite, workspaceId],
  );

  const handleIgnorePreview = useCallback(async () => {
    if (!api?.gitIgnorePreview || writeBusy) return;
    setWriteBusy(true);
    setWriteError(null);
    try {
      const preview = unwrap(await api.gitIgnorePreview(workspaceId));
      setIgnorePreviewData(preview);
      setIgnoreOpen(true);
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWriteBusy(false);
    }
  }, [api, writeBusy, workspaceId]);

  const handleIgnoreApply = useCallback(async () => {
    if (!api?.gitIgnoreApply) return;
    setIgnoreBusy(true);
    try {
      const result = await api.gitIgnoreApply(workspaceId);
      if (!result.ok) {
        setWriteError(result.message ?? "应用 .gitignore 失败");
        return;
      }
      setIgnoreOpen(false);
      setIgnorePreviewData(null);
      await runWrite(async () => ({ ok: true as const, value: undefined }), { reloadGraph: false });
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIgnoreBusy(false);
    }
  }, [api, runWrite, workspaceId]);

  const commits = useMemo(() => {
    if (!graph) return [];
    const query = filter.trim().toLowerCase();
    const author = authorSearch.trim().toLowerCase();
    const result = graph.commits.filter((commit) => {
      const matchesQuery =
        !query ||
        commit.sha.toLowerCase().includes(query) ||
        commit.subject.toLowerCase().includes(query) ||
        commit.authorName.toLowerCase().includes(query);
      const matchesAuthor = !author || commit.authorName.toLowerCase().includes(author);
      return matchesQuery && matchesAuthor;
    });
    if (sortMode === "date") {
      return [...result].sort(
        (left, right) => Date.parse(right.authorTime) - Date.parse(left.authorTime),
      );
    }
    return result;
  }, [graph, filter, authorSearch, sortMode]);

  // t398：过滤/排序后若选中提交已不可见，Inspector 跟随第一个可见提交，避免显示被过滤内容。
  useEffect(() => {
    if (commits.length === 0) return;
    if (commits.some((commit) => commit.sha === selectedSha)) return;
    const first = commits[0];
    setSelectedSha(first.sha);
    setJumpSha(first.sha);
    void loadCommit(first.sha);
  }, [commits, selectedSha, loadCommit]);

  const rows = useMemo(() => {
    return layoutGraph({ commits, maxLanes: 16 }).rows;
  }, [commits]);
  // t398：日期排序不是拓扑顺序，lane 坐标无意义；只保留表格，不渲染假 lane。
  const showLanes = sortMode === "topology";

  const onGraphKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!graph || commits.length === 0) return;
    const found = commits.findIndex((commit) => commit.sha === selectedSha);
    const index = found >= 0 ? found : 0;
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(commits.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = commits.length - 1;
    else return;
    event.preventDefault();
    const commit = commits[next];
    if (commit) {
      setSelectedSha(commit.sha);
      setJumpSha(commit.sha);
      rowRefs.current.get(commit.sha)?.focus();
    }
  };

  const runInit = async () => {
    if (!api?.gitInit || initBusy) return;
    setInitBusy(true);
    setInitError(null);
    try {
      const result = await api.gitInit(workspaceId);
      if (!result.ok) {
        if (result.errorCode === "GIT_INIT_ALREADY_REPO") {
          setInitOpen(false);
          await load(null, null);
          return;
        }
        setInitError(result.message ?? "初始化 Git 仓库失败，请重试");
        return;
      }
      setInitOpen(false);
      setInitSuccess(true);
      await load(null, null);
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInitBusy(false);
    }
  };

  if (!api) {
    return <section className="git-graph-panel" aria-label="版本图"><p role="alert">版本图不可用：桌面桥未加载。</p></section>;
  }

  if (initProbe && initProbe.status !== "already-repo" && !loading && !error) {
    return (
      <section className="git-graph-panel" aria-label="版本图">
        <header className="git-graph-top">
          <div>
            <h3>版本图</h3>
            <div className="muted tiny ellipsis" title={initProbe.workspacePath}>{initProbe.workspacePath}</div>
          </div>
          <div className="git-graph-top-meta">
            <span className="badge">只读</span>
            <button type="button" className="ghost small" onClick={() => void load()}>刷新</button>
          </div>
        </header>
        <div className="git-init-empty" role="status">
          <h4>{initProbe.status === "ready" ? "这个工作区还不是 Git 仓库" : "无法初始化 Git 仓库"}</h4>
          <p className="muted small">
            {initProbe.status === "ready"
              ? "初始化后可用分支、提交、工作区变更与合并队列；不会修改现有文件，也不会自动提交。"
              : initProbe.reason ?? "请检查工作区路径、权限与 Git 安装。"}
          </p>
          {initProbe.status === "ready" ? (
            <button type="button" className="primary git-init-cta" onClick={() => setInitOpen(true)}>
              初始化 Git 仓库
            </button>
          ) : null}
          {initSuccess ? <p className="muted small" role="status">Git 仓库已初始化（main，尚无提交）。</p> : null}
        </div>
        {initProbe.status === "ready" && initOpen ? (
          <GitInitModal
            workspacePath={initProbe.workspacePath}
            root={initProbe.root ?? initProbe.workspacePath}
            busy={initBusy}
            error={initError}
            onCancel={() => setInitOpen(false)}
            onConfirm={() => void runInit()}
          />
        ) : null}
      </section>
    );
  }

  // t391：SourceTree 风格四区布局。G1 handlers/WorkingTree/DiffView 全部复用。
  return (
    <section
      className={`git-graph-panel git-st-panel mobile-view-${view}`}
      aria-label="版本图"
      aria-busy={loading || busy}
    >
      <header className="git-st-toolbar">
        <div className="git-st-toolbar-title">
          <h3>版本图</h3>
          <span className="muted tiny ellipsis" title={repo?.root ?? ""}>
            {repo?.workspacePath ?? "读取仓库…"}
            {repo?.branch ? ` · ${repo.branch}` : repo?.detached ? " · detached" : ""}
          </span>
        </div>
        <div className="git-st-toolbar-controls">
          <span className="badge" title="查看/暂存/提交均写入本地仓库；不提供 push">本地可写</span>
          <button
            type="button"
            className="ghost tiny git-st-nav-toggle"
            aria-expanded={navOpen}
            aria-controls="git-st-nav"
            onClick={() => setNavOpen((value) => !value)}
          >
            导航
          </button>
          <label className="git-st-field">
            <span className="sr-only">分支范围</span>
            <select
              aria-label="分支范围"
              value={refFilter ?? ""}
              onChange={(event) => {
                const next = event.target.value || null;
                setRefFilter(next);
                void load(next);
              }}
            >
              <option value="">所有分支</option>
              {refs.map((ref) => (
                <option key={ref.fullName} value={ref.name}>
                  {ref.name}
                </option>
              ))}
            </select>
          </label>
          <label className="git-st-field">
            <span className="sr-only">排序</span>
            <select
              aria-label="提交排序"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as "topology" | "date")}
            >
              <option value="topology">拓扑排序</option>
              <option value="date">按日期</option>
            </select>
          </label>
          <label className="git-st-search">
            <span className="sr-only">搜索描述或提交</span>
            <input
              ref={commitSearchRef}
              type="search"
              value={filter}
              placeholder="搜索描述 / 提交"
              aria-label="搜索描述或提交"
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <label className="git-st-search">
            <span className="sr-only">Author Name 搜索</span>
            <input
              type="search"
              value={authorSearch}
              placeholder="Author Name"
              aria-label="Author Name 搜索 / 筛选提交"
              onChange={(event) => setAuthorSearch(event.target.value)}
            />
          </label>
          <label className="git-st-field">
            <span className="sr-only">跳到提交</span>
            <select
              aria-label="跳到提交"
              value={jumpSha}
              onChange={(event) => {
                if (event.target.value) openCommit(event.target.value);
              }}
            >
              <option value="">跳到…</option>
              {commits.slice(0, 50).map((commit) => (
                <option key={commit.sha} value={commit.sha}>
                  {commit.shortSha} {commit.subject.slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ghost small"
            aria-label="刷新 Git 面板"
            onClick={() => {
              void load();
              void loadWorking();
            }}
          >
            刷新
          </button>
        </div>
      </header>

      {initSuccess ? <p className="git-init-success" role="status">Git 仓库已初始化（main，尚无提交）。</p> : null}
      {error ? (
        <div className="git-graph-error" role="alert">
          {error} <button className="ghost tiny" onClick={() => void load()}>重试</button>
        </div>
      ) : null}
      {loading && !graph ? <p className="git-graph-loading" role="status">加载版本图…</p> : null}

      <div
        ref={layoutRef}
        className={`git-st-layout ${navOpen ? "nav-open" : ""} ${showLanes ? "" : "table-only"}`}
        style={workspaceHeightStyle(workspaceHeight)}
      >
        <aside
          className="git-st-nav"
          id="git-st-nav"
          aria-label="仓库导航"
        >
          <div className="git-st-nav-links" role="group" aria-label="仓库视图">
            <button
              type="button"
              className={navFocus === "history" ? "active" : ""}
              onClick={() => { setNavFocus("history"); selectView("graph"); }}
            >
              文件状态 / History
            </button>
            <button
              type="button"
              className={navFocus === "files" ? "active" : ""}
              onClick={() => { setNavFocus("files"); selectView("workspace"); }}
            >
              工作区变更
            </button>
            <button
              type="button"
              className={navFocus === "search" ? "active" : ""}
              onClick={() => { setNavFocus("search"); commitSearchRef.current?.focus(); }}
            >
              Search
            </button>
          </div>
          <label className="git-graph-filter">
            <span className="sr-only">搜索分支、标签、远程</span>
            <input
              value={refSearch}
              onChange={(event) => setRefSearch(event.target.value)}
              placeholder="搜索分支 / 标签 / 远程"
              aria-label="搜索分支、标签、远程"
            />
          </label>
          <button
            type="button"
            className={`git-ref-row ${refFilter == null ? "active" : ""}`}
            onClick={() => { setRefFilter(null); void load(null); }}
          >
            全部提交
          </button>

          {(["local", "tag", "remote", "head"] as const).map((kind) => {
            const group = refs.filter(
              (ref) =>
                ref.kind === kind &&
                (!refSearch.trim() ||
                  ref.name.toLowerCase().includes(refSearch.trim().toLowerCase())),
            );
            if (group.length === 0 && kind !== "remote") return null;
            const label = kind === "local" ? "分支" : kind === "tag" ? "标签" : kind === "remote" ? "远程" : "HEAD";
            return (
              <details key={kind} open={kind === "local"}>
                <summary>
                  {label} <span className="muted tiny">{group.length}</span>
                </summary>
                {group.map((ref) => {
                  const current = kind === "local" && repo?.branch === ref.name;
                  return (
                    <button
                      key={ref.fullName}
                      type="button"
                      className={`git-ref-row kind-${ref.kind} ${refFilter === ref.name ? "active" : ""} ${current ? "current" : ""}`}
                      onClick={() => { setRefFilter(ref.name); void load(ref.name); }}
                      title={ref.fullName}
                      aria-current={current ? "true" : undefined}
                    >
                      <span className="git-ref-dot" aria-hidden="true">{current ? "●" : "○"}</span>
                      <span className="ellipsis">{ref.name}</span>
                      {current ? (
                        <span className="git-ref-count" title="ahead/behind；分支提交总数待只读 API">
                          {repo?.ahead ? `↑${repo.ahead}` : ""}{repo?.behind ? `↓${repo.behind}` : ""}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </details>
            );
          })}

          <details open>
            <summary>工作树 <span className="muted tiny">{worktrees.length}</span></summary>
            {worktrees.map((worktree) => (
              <div key={worktree.path} className="git-worktree-row" title={worktree.path}>
                <span className="git-ref-kind">{worktree.bare ? "BARE" : worktree.detached ? "DETACHED" : "WORKTREE"}</span>
                <span className="ellipsis">{worktree.branch ?? worktree.path}</span>
              </div>
            ))}
          </details>
          <div className="git-st-stash muted tiny" title="只读 Stash API 尚未接入">
            Stash（暂存）· 待接入
          </div>
        </aside>

        <section className="git-st-history" aria-label="提交历史">
          <div className="git-st-history-head" role="row">
            <span className="git-st-col-lane" aria-hidden="true" />
            <span>描述</span>
            <span className="git-st-col-date">日期</span>
            <span className="git-st-col-author">作者</span>
            <span className="git-st-col-commit">提交</span>
          </div>
          <div
            className="git-st-history-body"
            role="listbox"
            aria-label="提交列表"
            aria-activedescendant={selectedSha ? `git-st-commit-${selectedSha}` : undefined}
            onKeyDown={onGraphKey}
          >
            <button
              type="button"
              className={`git-st-row git-st-working-row ${view === "workspace" ? "selected" : ""}`}
              onClick={() => { selectView("workspace"); setInspectorMode("diff"); void loadWorking(); }}
            >
              <span className="git-st-lane" aria-hidden="true">◌</span>
              <span className="git-st-subject">
                未提交的更改 {working ? working.staged.length + working.unstaged.length + working.untracked.length : 0}
              </span>
              <span className="git-st-col-date muted tiny">现在</span>
              <span className="git-st-col-author muted tiny">—</span>
              <span className="git-st-col-commit mono">WC</span>
            </button>
            <div className={`git-st-rows ${showLanes ? "" : "is-table-only"}`}>
              {showLanes ? (
                <svg
                  className="git-st-lanes"
                  aria-hidden="true"
                  width={Math.max(40, (graph?.layout.laneCount ?? 1) * 16 + 12)}
                  height={Math.max(0, rows.length * 22)}
                >
                  {rows.map((row, rowIndex) => (
                    <g key={row.sha}>
                      {row.parentLanes.map((parent) => {
                        const parentIndex = rows.findIndex((item) => item.sha === parent.sha);
                        return (
                          <line
                            key={`${row.sha}-${parent.sha}`}
                            x1={8 + row.lane * 16}
                            y1={rowIndex * 22 + 11}
                            x2={8 + parent.lane * 16}
                            y2={parentIndex >= 0 ? parentIndex * 22 + 11 : rows.length * 22}
                            className={`git-edge color-${row.color % 10}`}
                          />
                        );
                      })}
                      <circle
                        cx={8 + row.lane * 16}
                        cy={rowIndex * 22 + 11}
                        r={3.5}
                        className={`git-node color-${row.color % 10} ${row.sha === selectedSha ? "selected" : ""}`}
                      />
                    </g>
                  ))}
                </svg>
              ) : null}
              <div className="git-st-rows-list">
                {commits.map((commit, index) => (
                  <button
                    key={commit.sha}
                    ref={(node) => {
                      if (node) rowRefs.current.set(commit.sha, node);
                      else rowRefs.current.delete(commit.sha);
                    }}
                    id={`git-st-commit-${commit.sha}`}
                    type="button"
                    role="option"
                    aria-selected={commit.sha === selectedSha}
                    tabIndex={commit.sha === selectedSha ? 0 : -1}
                    className={`git-st-row ${commit.sha === selectedSha ? "selected" : ""}`}
                    onClick={() => openCommit(commit.sha)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      openCommit(commit.sha);
                    }}
                    aria-label={`${commit.shortSha} ${commit.subject}；${commit.authorName}；${commit.authorTime}`}
                    title={`${commit.subject}\n${commit.authorName} · ${commit.authorTime}`}
                  >
                    <span className="git-st-lane" aria-hidden="true">
                      {showLanes && rows[index] ? `L${rows[index]!.lane + 1}` : ""}
                    </span>
                    <span className="git-st-subject ellipsis">
                      {commit.subject}
                      {commit.refs.slice(0, 3).map((ref) => (
                        <span key={ref} className="badge git-ref-badge">{ref}</span>
                      ))}
                    </span>
                    <span className="git-st-col-date muted tiny">{commit.authorTime.slice(0, 16)}</span>
                    <span className="git-st-col-author muted tiny ellipsis">{commit.authorName}</span>
                    <span className="git-st-col-commit mono">{commit.shortSha}</span>
                  </button>
                ))}
              </div>
            </div>
            {commits.length === 0 && !loading ? (
              <p className="muted small git-st-empty">
                {graph && graph.commits.length === 0
                  ? `${repo?.branch ?? "main"} 尚无提交。工作区文件已就绪，但尚未创建首个提交。`
                  : "没有匹配提交。"}
              </p>
            ) : null}
          </div>
          {graph?.hasMore ? (
            <button type="button" className="ghost small git-graph-more" onClick={() => void loadMore()} disabled={busy}>
              {busy ? "加载…" : "加载更早提交"}
            </button>
          ) : null}
        </section>

        <div className="git-st-filter" role="group" aria-label="文件筛选">
          <span className="muted tiny">筛选</span>
          <label className="git-st-field">
            <span className="sr-only">按状态排序</span>
            <select
              aria-label="文件排序"
              value={fileSort}
              onChange={(event) => setFileSort(event.target.value as "path" | "status")}
            >
              <option value="path">按路径</option>
              <option value="status">按状态</option>
            </select>
          </label>
          <label className="git-check">
            <input
              type="checkbox"
              checked={compactFiles}
              onChange={(event) => setCompactFiles(event.target.checked)}
            />
            紧凑列表
          </label>
          <label className="git-st-search">
            <span className="sr-only">搜索文件</span>
            <input
              ref={filterInputRef}
              type="search"
              value={fileFilter}
              placeholder="搜索文件 / 状态"
              aria-label="搜索工作区文件"
              onChange={(event) => setFileFilter(event.target.value)}
            />
          </label>
        </div>

        {/* t432（G9）：历史与工作区之间的水平分隔条——可拖拽/键盘调整，双击恢复默认 300px。 */}
        <div
          className="git-st-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整历史与工作区高度"
          aria-valuemin={GIT_WS_MIN}
          aria-valuemax={
            splitterUsable(containerHeight)
              ? Math.round(maxWorkspaceHeight(containerHeight))
              : GIT_WS_MIN
          }
          aria-valuenow={Math.round(workspaceHeight)}
          aria-valuetext={`工作区高度 ${Math.round(workspaceHeight)} 像素`}
          tabIndex={0}
          title="拖动调整历史与工作区高度；方向键 ±16px；Home/End 最小/最大；双击恢复默认"
          onPointerDown={onSplitterPointerDown}
          onKeyDown={onSplitterKeyDown}
          onDoubleClick={() => commitWorkspaceHeight(GIT_WS_DEFAULT)}
        />

        <section className="git-st-workspace" aria-label="工作区与 Diff">
          <div className="git-st-working">
            <WorkingTree
              status={working}
              loading={busy && !working}
              onRefresh={() => void loadWorking()}
              onOpen={openWorkingFile}
              diff={null}
              fileFilter={fileFilter}
              fileSort={fileSort}
              compact={compactFiles}
              isFirstCommit={!loading && repo !== null && !repo.headSha}
              writeBusy={writeBusy}
              writeError={writeError}
              onDismissWriteError={() => setWriteError(null)}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onCommit={(title, body) => void handleCommit(title, body)}
              onIgnorePreview={() => void handleIgnorePreview()}
              lastCommitSha={lastCommitSha}
              canWrite={Boolean(api?.gitStage && api?.gitUnstage && api?.gitCreateCommit)}
            />
          </div>
          <aside className="git-st-inspector" aria-label="Diff 与提交详情">
            {inspectorMode === "diff" ? (
              <>
                <div className="git-st-inspector-head">
                  <h3>文件 diff</h3>
                  <button type="button" className="ghost tiny" onClick={() => setInspectorMode("commit")}>
                    查看提交
                  </button>
                </div>
                {workingDiff ? (
                  <DiffView diff={workingDiff} loading={busy} />
                ) : (
                  <p className="muted small git-st-empty">
                    选择一个工作区文件查看 diff；也可以选择提交查看详情。
                  </p>
                )}
              </>
            ) : detail ? (
              <div className="git-st-commit-detail">
                <h2 className="git-detail-title">{detail.node.subject}</h2>
                <div className="muted tiny mono">{detail.node.sha}</div>
                <div className="git-detail-meta">
                  <span>{detail.node.authorName}</span>
                  <span>{detail.node.authorTime}</span>
                  <span>{detail.stats.files} 文件 · +{detail.stats.insertions} / -{detail.stats.deletions}</span>
                </div>
                <div className="row gap">
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => void navigator.clipboard?.writeText(detail.node.sha)}
                  >
                    复制 SHA
                  </button>
                  {detail.node.refs.map((ref) => <span key={ref} className="badge">{ref}</span>)}
                </div>
                <h3>变更文件</h3>
                <ul className="git-detail-files" aria-label="变更文件">
                  {detail.changedFiles.map((file) => (
                    <li key={file.path}>
                      <span className="badge">{file.status}</span>{" "}
                      <span className="ellipsis">{file.path}</span>
                    </li>
                  ))}
                </ul>
                <DiffView diff={detail.diff} loading={busy} error={error} />
              </div>
            ) : (
              <p className="muted small git-st-empty">
                选择一个提交查看详情，或选择一个工作区文件查看 diff。
              </p>
            )}
          </aside>
        </section>

        <div className="git-st-tabs" role="tablist" aria-label="版本视图" onKeyDown={onTabKey}>
          {(["graph", "workspace", "detail"] as const).map((item) => (
            <button
              key={item}
              ref={(node) => { tabRefs.current[item] = node; }}
              id={`git-graph-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={view === item}
              aria-controls={`git-graph-panel-${item}`}
              tabIndex={view === item ? 0 : -1}
              className={view === item ? "active" : ""}
              onClick={() => selectView(item)}
            >
              {item === "graph" ? "历史" : item === "workspace" ? "工作区" : "Diff"}
            </button>
          ))}
        </div>
      </div>
      {graph ? (
        <footer className="git-graph-footer muted tiny">
          已加载 {graph.totalLoaded} / 2000 · 本地快照 · 提交仅写入本地（无 push） · {repo?.remote ? "远程已配置" : "无远程"}
        </footer>
      ) : null}

      {ignoreOpen && ignorePreviewData ? (
        <Modal
          title="生成 .gitignore"
          description={
            ignorePreviewData.exists
              ? "仅追加缺失的模板行，现有内容保持不变"
              : "将创建 .gitignore 并仅写入下列模板行；后续再生成也只追加缺失行，不覆盖任何现有文件"
          }
          onClose={() => setIgnoreOpen(false)}
        >
          <div className="git-ignore-preview">
            {ignorePreviewData.additions.length === 0 ? (
              <p className="muted small">模板条目已全部存在，无需追加（不会修改文件）。</p>
            ) : (
              <>
                <p className="muted small">
                  {ignorePreviewData.exists
                    ? `仅追加缺失的 ${ignorePreviewData.additions.length} 行模板条目（node_modules/、dist/、dist-electron/、branches/ 等），现有内容保持不变。`
                    : `将创建 .gitignore 并写入 ${ignorePreviewData.additions.length} 行常见忽略条目（node_modules/、dist/、dist-electron/、branches/ 等）；不会覆盖任何现有文件。`}
                </p>
                <pre className="git-ignore-diff" aria-label="将追加的内容"><code>{`+ ${ignorePreviewData.additions.join("\n+ ")}`}</code></pre>
                {ignorePreviewData.exists && ignorePreviewData.existing ? (
                  <details>
                    <summary className="muted small">查看现有 .gitignore（保持不变）</summary>
                    <pre className="git-ignore-existing"><code>{ignorePreviewData.existing}</code></pre>
                  </details>
                ) : null}
              </>
            )}
            <div className="modal-foot">
              <button type="button" className="ghost" onClick={() => setIgnoreOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={ignoreBusy || ignorePreviewData.additions.length === 0}
                onClick={() => void handleIgnoreApply()}
              >
                {ignoreBusy ? "应用中…" : "追加缺失行"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );

}

function WorkingTree({
  status,
  loading,
  onRefresh,
  onOpen,
  diff,
  fileFilter = "",
  fileSort = "path",
  compact = false,
  isFirstCommit,
  writeBusy,
  writeError,
  onDismissWriteError,
  onStage,
  onUnstage,
  onCommit,
  onIgnorePreview,
  lastCommitSha,
  canWrite,
}: {
  status: GitWorkingStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (file: GitWorkingFile) => void;
  diff: GitDiffPage | null;
  fileFilter?: string;
  fileSort?: "path" | "status";
  compact?: boolean;
  /** 空仓库（一键 init 后尚无提交）：显示首次提交引导。 */
  isFirstCommit: boolean;
  writeBusy: boolean;
  writeError: string | null;
  onDismissWriteError: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (title: string, body: string) => void;
  onIgnorePreview: () => void;
  lastCommitSha: string | null;
  canWrite: boolean;
}) {
  const [selectedUnstaged, setSelectedUnstaged] = useState<Set<string>>(new Set());
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [commitTitle, setCommitTitle] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [commitBodyOpen, setCommitBodyOpen] = useState(false);
  const [sectionRatio, setSectionRatio] = useState(SECTION_RATIO_DEFAULT);
  const [sectionTab, setSectionTab] = useState<"staged" | "unstaged">("unstaged");
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  function beginSectionResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const height = sectionsRef.current?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    dragCleanupRef.current?.();
    dragCleanupRef.current = attachSectionDrag({
      startY: event.clientY,
      startRatio: sectionRatio,
      height,
      onRatio: setSectionRatio,
      target: window,
    });
  }

  function onSectionResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = ratioAfterKey(sectionRatio, event.key);
    if (next === null) return;
    event.preventDefault();
    setSectionRatio(next);
  }

  // 状态刷新后清掉已失效的勾选。
  useEffect(() => {
    const valid = new Set(
      [...(status?.unstaged ?? []), ...(status?.untracked ?? [])].map((file) => file.path),
    );
    setSelectedUnstaged((prev) => new Set([...prev].filter((path) => valid.has(path))));
  }, [status]);
  useEffect(() => {
    const valid = new Set((status?.staged ?? []).map((file) => file.path));
    setSelectedStaged((prev) => new Set([...prev].filter((path) => valid.has(path))));
  }, [status]);

  function toggle(set: Set<string>, path: string): Set<string> {
    const next = new Set(set);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  }

  function submitCommit(event: React.FormEvent) {
    event.preventDefault();
    const title = commitTitle.trim();
    if (!title || writeBusy) return;
    onCommit(title, commitBody);
    setCommitTitle("");
    setCommitBody("");
  }

  const stagedCount = status?.staged.length ?? 0;
  const unstagedFiles = useMemo(
    () => [...(status?.unstaged ?? []), ...(status?.untracked ?? [])],
    [status],
  );
  const filterFile = (file: GitWorkingFile) => {
    const needle = fileFilter.trim().toLowerCase();
    if (!needle) return true;
    return (
      file.path.toLowerCase().includes(needle) ||
      file.oldPath?.toLowerCase().includes(needle) ||
      statusLabel(file).toLowerCase().includes(needle)
    );
  };
  const sortFiles = (files: GitWorkingFile[]) =>
    [...files].sort((left, right) =>
      fileSort === "status"
        ? statusLabel(left).localeCompare(statusLabel(right)) || left.path.localeCompare(right.path)
        : left.path.localeCompare(right.path),
    );
  const visibleStaged = sortFiles((status?.staged ?? []).filter(filterFile));
  const visibleUnstaged = sortFiles(unstagedFiles.filter(filterFile));

  return (
    <div className={`git-working-tree ${compact ? "compact" : ""} show-sections`}>
      <div className="git-ws-toolbar">
        <h3>工作区</h3>
        <div className="row gap">
          {canWrite ? (
            <button
              type="button"
              className="ghost tiny"
              onClick={onIgnorePreview}
              disabled={writeBusy}
              title="预览并追加常见忽略条目（node_modules/、dist/ 等）"
            >
              生成 .gitignore
            </button>
          ) : null}
          <button type="button" className="ghost tiny" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </div>

      {isFirstCommit && canWrite ? (
        <div className="git-first-commit" role="note" aria-label="首次提交引导">
          <strong>首次提交</strong>
          <p className="muted small">
            这是全新仓库，还没有任何提交。三步完成首次提交：
            ① 在下方勾选文件并点「暂存选中」；② 填写提交标题；③ 点「提交（N 个文件）」。
            可先生成 .gitignore 忽略 node_modules/ 等目录。
          </p>
        </div>
      ) : null}

      {writeError ? (
        <div className="git-write-error" role="alert">
          {writeError}
          <div className="row gap">
            <button type="button" className="ghost tiny" onClick={onRefresh} disabled={writeBusy}>
              重试刷新
            </button>
            <button type="button" className="ghost tiny" onClick={onDismissWriteError}>
              关闭
            </button>
          </div>
        </div>
      ) : null}

      {lastCommitSha ? (
        <p className="git-write-ok" role="status">
          已提交 <code>{lastCommitSha.slice(0, 8)}</code>（仅本地，未推送）。
        </p>
      ) : null}
      {loading ? <p role="status">读取工作区…</p> : null}

      {status ? (
        <>
          <div className="git-ws-status muted tiny" aria-label="工作区状态">
            冲突 {status.conflicts.length} · 子模块 {status.submodules.length}
            {status.submodulesUnsupported ? " · 子模块读取不可用" : ""}
            {status.truncated ? " · 文件过多，仅显示部分" : ""}
          </div>

          <div className="git-ws-segment-tabs" role="tablist" aria-label="工作区文件段">
            <button
              type="button"
              role="tab"
              aria-selected={sectionTab === "staged"}
              onClick={() => setSectionTab("staged")}
            >
              已暂存 ({visibleStaged.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sectionTab === "unstaged"}
              onClick={() => setSectionTab("unstaged")}
            >
              未暂存 / 未跟踪 ({visibleUnstaged.length})
            </button>
          </div>

          <div className="git-ws-sections" ref={sectionsRef}>
            <section
              className={`git-ws-section ${visibleStaged.length === 0 ? "is-empty" : ""} ${sectionTab === "staged" ? "" : "mobile-hidden"}`}
              style={{ flexBasis: `${sectionRatio}%`, flexGrow: 0, flexShrink: 0 }}
              aria-label={`已暂存文件，共 ${visibleStaged.length} 个`}
            >
              <div className="git-ws-section-head">
                <label className="git-check git-ws-section-title">
                  <input
                    type="checkbox"
                    aria-label="全选已暂存文件"
                    checked={visibleStaged.length > 0 && selectedStaged.size === visibleStaged.length}
                    onChange={(event) =>
                      setSelectedStaged(
                        event.target.checked
                          ? new Set(visibleStaged.map((file) => file.path))
                          : new Set(),
                      )
                    }
                    disabled={!canWrite || writeBusy || visibleStaged.length === 0}
                  />
                  已暂存 ({visibleStaged.length})
                </label>
                {canWrite ? (
                  <button
                    type="button"
                    className="ghost tiny"
                    aria-label={`取消暂存选中 ${selectedStaged.size} 个文件`}
                    disabled={writeBusy || selectedStaged.size === 0}
                    onClick={() => {
                      onUnstage([...selectedStaged]);
                      setSelectedStaged(new Set());
                    }}
                  >
                    − 取消暂存选中 ({selectedStaged.size})
                  </button>
                ) : null}
              </div>
              <div className="git-ws-section-list" data-git-section="staged">
                {visibleStaged.length === 0 ? (
                  <div className="git-ws-empty">没有已暂存文件。</div>
                ) : (
                  <ul className="git-status-files">
                    {visibleStaged.map((file) => (
                      <li key={`staged-${file.path}`} className="git-file-row">
                        <label className="git-check ellipsis" title={file.path}>
                          <input
                            type="checkbox"
                            checked={selectedStaged.has(file.path)}
                            onChange={() => setSelectedStaged((prev) => toggle(prev, file.path))}
                            disabled={!canWrite || writeBusy}
                          />
                          <span className="badge">{statusLabel(file)}</span>
                          <span className="ellipsis">
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          </span>
                        </label>
                        <button
                          type="button"
                          className="ghost tiny git-file-open"
                          aria-label={`取消暂存 ${file.path}`}
                          title="取消暂存"
                          disabled={!canWrite || writeBusy}
                          onClick={() => onUnstage([file.path])}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="ghost tiny git-file-open"
                          aria-label={`查看 ${file.path} 的 diff`}
                          title="查看 diff"
                          onClick={() => onOpen(file)}
                        >
                          ◫
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {visibleStaged.length > 0 && visibleUnstaged.length > 0 ? (
              <div
                className="git-ws-resizer"
                role="separator"
                aria-orientation="horizontal"
                aria-label="调整已暂存与未暂存列表高度"
                aria-valuemin={SECTION_RATIO_MIN}
                aria-valuemax={SECTION_RATIO_MAX}
                aria-valuenow={Math.round(sectionRatio)}
                data-testid="git-ws-resizer"
                tabIndex={0}
                onPointerDown={beginSectionResize}
                onKeyDown={onSectionResizeKey}
                title="拖拽调整高度；Home 恢复 38/62"
              />
            ) : null}

            <section
              className={`git-ws-section ${visibleUnstaged.length === 0 ? "is-empty" : ""} ${sectionTab === "unstaged" ? "" : "mobile-hidden"}`}
              aria-label={`未暂存或未跟踪文件，共 ${visibleUnstaged.length} 个`}
            >
              <div className="git-ws-section-head">
                <label className="git-check git-ws-section-title">
                  <input
                    type="checkbox"
                    aria-label="全选未暂存文件"
                    checked={
                      visibleUnstaged.length > 0 && selectedUnstaged.size === visibleUnstaged.length
                    }
                    onChange={(event) =>
                      setSelectedUnstaged(
                        event.target.checked
                          ? new Set(visibleUnstaged.map((file) => file.path))
                          : new Set(),
                      )
                    }
                    disabled={!canWrite || writeBusy || visibleUnstaged.length === 0}
                  />
                  未暂存 / 未跟踪 ({visibleUnstaged.length})
                </label>
                {canWrite ? (
                  <button
                    type="button"
                    className="ghost tiny"
                    aria-label={`暂存选中 ${selectedUnstaged.size} 个文件`}
                    disabled={writeBusy || selectedUnstaged.size === 0}
                    onClick={() => {
                      onStage([...selectedUnstaged]);
                      setSelectedUnstaged(new Set());
                    }}
                  >
                    + 暂存选中 ({selectedUnstaged.size})
                  </button>
                ) : null}
              </div>
              <div className="git-ws-section-list" data-git-section="unstaged">
                {visibleUnstaged.length === 0 ? (
                  <div className="git-ws-empty">没有未暂存或未跟踪文件。</div>
                ) : (
                  <ul className="git-status-files">
                    {visibleUnstaged.map((file) => (
                      <li key={`unstaged-${file.path}`} className="git-file-row">
                        <label className="git-check ellipsis" title={file.path}>
                          <input
                            type="checkbox"
                            checked={selectedUnstaged.has(file.path)}
                            onChange={() =>
                              setSelectedUnstaged((prev) => toggle(prev, file.path))
                            }
                            disabled={!canWrite || writeBusy}
                          />
                          <span className="badge">{statusLabel(file)}</span>
                          <span className="ellipsis">
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          </span>
                        </label>
                        <button
                          type="button"
                          className="ghost tiny git-file-open"
                          aria-label={`暂存 ${file.path}`}
                          title="暂存"
                          disabled={!canWrite || writeBusy}
                          onClick={() => onStage([file.path])}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="ghost tiny git-file-open"
                          aria-label={`查看 ${file.path} 的 diff`}
                          title="查看 diff"
                          onClick={() => onOpen(file)}
                        >
                          ◫
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </>
      ) : !loading ? (
        <div className="git-ws-empty">工作区干净，没有可暂存文件。</div>
      ) : null}

      {canWrite ? (
        <form className="git-commit-box git-ws-commit" onSubmit={submitCommit} aria-label="提交已暂存文件">
          <div className="git-ws-commit-row">
            <label className="git-ws-commit-title">
              提交标题（必填）
              <input
                value={commitTitle}
                onChange={(event) => setCommitTitle(event.target.value)}
                placeholder="例如：feat: 补齐健康检查接口"
                maxLength={100}
                disabled={writeBusy}
                required
              />
            </label>
            <span className="git-ws-staged-count">已暂存 {stagedCount} 文件</span>
            <button
              type="submit"
              className="primary small"
              disabled={writeBusy || stagedCount === 0 || !commitTitle.trim()}
            >
              {writeBusy ? "提交中…" : `提交（${stagedCount} 个文件）`}
            </button>
          </div>
          <div className="row between git-ws-commit-foot">
            <button
              type="button"
              className="ghost tiny"
              aria-expanded={commitBodyOpen}
              onClick={() => setCommitBodyOpen((value) => !value)}
            >
              {commitBodyOpen ? "收起正文" : "正文（可选）"}
            </button>
            <span className="muted tiny">仅本地提交，无推送。</span>
          </div>
          {commitBodyOpen ? (
            <label>
              提交正文
              <textarea
                value={commitBody}
                onChange={(event) => setCommitBody(event.target.value)}
                rows={2}
                maxLength={5000}
                placeholder="背景、改动点、验证方式…"
                disabled={writeBusy}
              />
            </label>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}


function DiffView({
  diff,
  loading = false,
  error = null,
}: {
  diff: GitDiffPage;
  loading?: boolean;
  error?: string | null;
}) {
  return <GitDiffViewer diff={diff} loading={loading} error={error} />;
}
