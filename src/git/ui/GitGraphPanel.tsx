import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutGraph } from "../graph.js";
import "./gitGraph.css";
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
import type { GitResult } from "../types.js";

type Api = NonNullable<Window["deer"]>;

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
  const [view, setView] = useState<"graph" | "detail" | "workspace">("graph");
  const [filter, setFilter] = useState("");
  const [refFilter, setRefFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRefs, setShowRefs] = useState(true);
  const requestRef = useRef(0);
  const tabRefs = useRef<Record<"graph" | "detail" | "workspace", HTMLButtonElement | null>>({
    graph: null,
    detail: null,
    workspace: null,
  });
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const loadCommit = useCallback(
    async (sha: string) => {
      if (!api) return;
      try {
        const value = unwrap(await api.gitCommit(workspaceId, sha));
        setDetail(value);
        setSelectedSha(sha);
      } catch (cause) {
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
      try {
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
    if (next === "workspace") void loadWorking();
    if (focus) tabRefs.current[next]?.focus();
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
    if (!api || busy) return;
    setBusy(true);
    try {
      const scope = file.staged ? "staged" as const : "working" as const;
      setWorkingDiff(unwrap(await api.gitDiff(workspaceId, { scope, path: file.path, context: 3 })));
      setView("workspace");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commits = useMemo(() => {
    if (!graph) return [];
    const query = filter.trim().toLowerCase();
    if (!query) return graph.commits;
    return graph.commits.filter(
      (commit) => commit.sha.toLowerCase().includes(query) || commit.subject.toLowerCase().includes(query),
    );
  }, [graph, filter]);

  const commitBySha = useMemo(() => {
    const map = new Map<string, (NonNullable<typeof graph>["commits"][number])>();
    for (const commit of graph?.commits ?? []) map.set(commit.sha, commit);
    return map;
  }, [graph]);

  const rows = useMemo(() => {
    if (!graph) return [];
    const all = layoutGraph({ commits: graph.commits, maxLanes: 16 }).rows;
    return all;
  }, [graph]);

  const onGraphKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!graph) return;
    const index = Math.max(0, graph.commits.findIndex((commit) => commit.sha === selectedSha));
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(graph.commits.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = graph.commits.length - 1;
    else return;
    event.preventDefault();
    const commit = graph.commits[next];
    if (commit) {
      setSelectedSha(commit.sha);
      rowRefs.current.get(commit.sha)?.focus();
    }
  };

  if (!api) {
    return <section className="git-graph-panel" aria-label="版本图"><p role="alert">版本图不可用：桌面桥未加载。</p></section>;
  }

  return (
    <section className="git-graph-panel" aria-label="版本图" aria-busy={loading || busy}>
      <header className="git-graph-top">
        <div>
          <h3>版本图</h3>
          <div className="muted tiny ellipsis" title={repo?.root ?? ""}>
            {repo?.workspacePath ?? "读取仓库…"}{repo?.branch ? ` · ${repo.branch}` : repo?.detached ? " · detached" : ""}
          </div>
        </div>
        <div className="git-graph-top-meta">
          {repo && (
            <span className="badge">
              {repo.ahead > 0 ? `↑${repo.ahead}` : "↑0"} {repo.behind > 0 ? `↓${repo.behind}` : "↓0"}
            </span>
          )}
          <span className="badge">只读</span>
          <button type="button" className="ghost small" onClick={() => void load()}>刷新</button>
          <button type="button" className="ghost small" aria-pressed={showRefs} onClick={() => setShowRefs((value) => !value)}>
            {showRefs ? "收起引用" : "显示引用"}
          </button>
        </div>
      </header>

      {error ? <div className="git-graph-error" role="alert">{error} <button className="ghost tiny" onClick={() => void load()}>重试</button></div> : null}
      {loading && !graph ? <p className="git-graph-loading" role="status">加载版本图…</p> : null}

      <div className="git-graph-tabs" role="tablist" aria-label="版本视图" onKeyDown={onTabKey}>
        {(["graph", "detail", "workspace"] as const).map((item) => (
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
            {item === "graph" ? "图" : item === "detail" ? "详情" : "工作区"}
          </button>
        ))}
      </div>

      <div className={`git-graph-body ${showRefs ? "with-refs" : ""} view-${view}`}>
        <aside className="git-graph-refs" aria-label="分支与标签">
          <label className="git-graph-filter">
            <span className="sr-only">筛选提交</span>
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选提交 / SHA" aria-label="筛选提交" />
          </label>
          <button type="button" className={`git-ref-row ${refFilter == null ? "active" : ""}`} onClick={() => { setRefFilter(null); void load(null); }}>
            全部提交
          </button>
          {refs.map((ref) => (
            <button
              key={ref.fullName}
              type="button"
              className={`git-ref-row kind-${ref.kind} ${refFilter === ref.name ? "active" : ""}`}
              onClick={() => { setRefFilter(ref.name); void load(ref.name); }}
              title={ref.fullName}
            >
              <span className="git-ref-kind">{ref.kind === "head" ? "HEAD" : ref.kind === "tag" ? "TAG" : ref.kind === "remote" ? "REMOTE" : "BRANCH"}</span>
              <span className="ellipsis">{ref.name}</span>
            </button>
          ))}
          {refs.length === 0 && !loading ? <p className="muted tiny">没有分支或标签。</p> : null}
          <h4>工作树 ({worktrees.length})</h4>
          {worktrees.map((worktree) => (
            <div key={worktree.path} className="git-worktree-row" title={worktree.path}>
              <span className="git-ref-kind">{worktree.bare ? "BARE" : worktree.detached ? "DETACHED" : "WORKTREE"}</span>
              <span className="ellipsis">{worktree.branch ?? worktree.path}</span>
            </div>
          ))}
        </aside>

        <div
          className="git-graph-center"
          id="git-graph-panel-graph"
          role="tabpanel"
          aria-labelledby="git-graph-tab-graph"
          aria-label="提交图"
        >
          <div
            className="git-graph-list-wrap"
            role="listbox"
            aria-label="提交列表"
            aria-activedescendant={selectedSha ? `git-commit-${selectedSha}` : undefined}
            onKeyDown={onGraphKey}
          >
            <svg
              className="git-graph-svg"
              aria-hidden="true"
              width={Math.max(40, (graph?.layout.laneCount ?? 1) * 18 + 12)}
              height={Math.max(40, rows.length * 30)}
            >
              {rows.map((row, rowIndex) => (
                <g key={row.sha}>
                  {row.parentLanes.map((parent) => {
                    const parentIndex = rows.findIndex((item) => item.sha === parent.sha);
                    const y1 = rowIndex * 30 + 15;
                    const y2 = parentIndex >= 0 ? parentIndex * 30 + 15 : rows.length * 30;
                    return (
                      <line
                        key={`${row.sha}-${parent.sha}`}
                        x1={8 + row.lane * 18}
                        y1={y1}
                        x2={8 + parent.lane * 18}
                        y2={y2}
                        className={`git-edge color-${row.color % 10}`}
                      />
                    );
                  })}
                  <circle cx={8 + row.lane * 18} cy={rowIndex * 30 + 15} r={4} className={`git-node color-${row.color % 10} ${row.sha === selectedSha ? "selected" : ""}`} />
                </g>
              ))}
            </svg>
            <div className="git-graph-rows" style={{ paddingLeft: Math.max(18, (graph?.layout.laneCount ?? 1) * 18) }}>
              {commits.map((commit) => {
                const row = commitBySha.get(commit.sha);
                return (
                  <button
                    key={commit.sha}
                    ref={(node) => {
                      if (node) rowRefs.current.set(commit.sha, node);
                      else rowRefs.current.delete(commit.sha);
                    }}
                    id={`git-commit-${commit.sha}`}
                    type="button"
                    role="option"
                    aria-selected={commit.sha === selectedSha}
                    tabIndex={commit.sha === selectedSha ? 0 : -1}
                    className={`git-commit-row ${commit.sha === selectedSha ? "selected" : ""}`}
                    onClick={() => { setSelectedSha(commit.sha); void loadCommit(commit.sha); }}
                  >
                    <span className="mono git-sha">{commit.shortSha}</span>
                    <span className="git-subject ellipsis" title={commit.subject}>{commit.subject}</span>
                    <span className="muted tiny">{commit.authorName}</span>
                    {commit.refs.slice(0, 2).map((ref) => <span key={ref} className="badge git-ref-badge">{ref}</span>)}
                    <span className="muted tiny">{row ? `L${row.lane + 1}` : ""}</span>
                  </button>
                );
              })}
              {commits.length === 0 && !loading ? <p className="muted small">没有匹配提交。</p> : null}
            </div>
          </div>
          {graph?.hasMore ? (
            <button type="button" className="ghost small git-graph-more" onClick={() => void loadMore()} disabled={busy}>
              {busy ? "加载…" : "加载更早提交"}
            </button>
          ) : null}
          {graph?.truncated ? <p className="muted tiny">仅显示最近 2000 条提交 / 超过 16 lane 已折叠。</p> : null}
        </div>

        <aside
          className="git-graph-detail"
          id="git-graph-panel-detail"
          role="tabpanel"
          aria-labelledby="git-graph-tab-detail"
          aria-label="提交详情"
        >
          {view === "workspace" ? (
            <div id="git-graph-panel-workspace" role="tabpanel" aria-labelledby="git-graph-tab-workspace">
              <WorkingTree
                status={working}
                loading={busy && !working}
                onRefresh={() => void loadWorking()}
                onOpen={openWorkingFile}
                diff={workingDiff}
              />
            </div>
          ) : detail ? (
            <>
              <h2 className="git-detail-title">{detail.node.subject}</h2>
              <div className="muted tiny mono">{detail.node.sha}</div>
              <div className="git-detail-meta">
                <span>{detail.node.authorName}</span>
                <span>{detail.node.authorTime}</span>
                <span>{detail.stats.files} 文件 · +{detail.stats.insertions} / -{detail.stats.deletions}</span>
              </div>
              <div className="row gap">
                <button type="button" className="ghost tiny" onClick={() => void navigator.clipboard?.writeText(detail.node.sha)}>复制 SHA</button>
                {detail.node.refs.map((ref) => <span key={ref} className="badge">{ref}</span>)}
              </div>
              <h3>变更文件</h3>
              <ul className="git-detail-files" aria-label="变更文件">
                {detail.changedFiles.map((file) => (
                  <li key={file.path}><span className="badge">{file.status}</span> <span className="ellipsis">{file.path}</span></li>
                ))}
              </ul>
              <DiffView diff={detail.diff} />
            </>
          ) : (
            <p className="muted small">选择一个提交查看详情。</p>
          )}
        </aside>
      </div>
      {graph && <footer className="git-graph-footer muted tiny">已加载 {graph.totalLoaded} / 2000 · 只读快照 · {repo?.remote ? "远程已配置" : "无远程"}</footer>}
    </section>
  );
}

function WorkingTree({
  status,
  loading,
  onRefresh,
  onOpen,
  diff,
}: {
  status: GitWorkingStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (file: GitWorkingFile) => void;
  diff: GitDiffPage | null;
}) {
  return (
    <div>
      <div className="row between">
        <h3>工作区</h3>
        <button type="button" className="ghost tiny" onClick={onRefresh}>刷新</button>
      </div>
      {loading ? <p role="status">读取工作区…</p> : null}
      {status ? (
        <>
          {(["staged", "unstaged", "untracked", "conflicts"] as const).map((key) => (
            <section key={key}>
              <h4>{key === "staged" ? "已暂存" : key === "unstaged" ? "未暂存" : key === "untracked" ? "未跟踪" : "冲突"} ({status[key].length})</h4>
              <ul className="git-status-files">
                {status[key].map((file) => (
                  <li key={`${key}-${file.path}`}>
                    <button type="button" className="ghost tiny" onClick={() => onOpen(file)}>
                      <span className="badge">{statusLabel(file)}</span>{" "}
                      <span className="ellipsis" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section>
            <h4>子模块 ({status.submodules.length})</h4>
            {status.submodulesUnsupported ? <p className="muted tiny">子模块状态不可用（git submodule 读取失败）。</p> : null}
            <ul className="git-status-files">
              {status.submodules.map((file) => (
                <li key={`submodule-${file.path}`}>
                  <span className="badge">S</span> <span className="ellipsis">{file.path}</span>
                </li>
              ))}
            </ul>
          </section>
          {status.truncated ? <p className="muted tiny">工作区文件过多，仅显示部分。</p> : null}
        </>
      ) : !loading ? <p className="muted small">没有工作区变更，或尚未读取。</p> : null}
      {diff ? <><h3>文件 diff</h3><DiffView diff={diff} /></> : null}
    </div>
  );
}

function DiffView({ diff }: { diff: GitDiffPage }) {
  if (diff.binary || diff.submodule) {
    return <p className="muted small">{diff.submodule ? "子模块变更不展开。" : "二进制文件不显示 diff。"}</p>;
  }
  return (
    <div className="git-diff">
      {diff.truncated ? <p className="muted tiny">diff 已截断（{diff.bytes} bytes）。</p> : null}
      {diff.files.map((file) => (
        <section key={file.path}>
          <h4 className="mono">{file.path}</h4>
          {file.hunks.map((hunk, index) => (
            <pre key={index} className="git-hunk"><code>{hunk.header}{"\n"}{hunk.lines.map((line) => `${line.kind}${line.text}`).join("\n")}</code></pre>
          ))}
        </section>
      ))}
      {diff.files.length === 0 ? <p className="muted small">没有文本 diff。</p> : null}
    </div>
  );
}
