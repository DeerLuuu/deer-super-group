import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, BoardKind } from "../shared/types";
import type {
  BoardArchiveProposal,
  BoardEntry,
  Confidence,
  MemoryResult,
  MemorySearchResult,
  MemorySnapshot,
  MemorySnapshotOptions,
  Memo,
  MemoKind,
} from "../memory/types";
import Modal from "../Modal";
import EmptyState from "../EmptyState";
import Markdown from "../Markdown";

type MemoryTab = "board" | "memo" | "archive";
type NotifyKind = "success" | "error";

const TAB_KEY = "deer.memory.tab.";
const BOARD_KIND_LABEL: Record<BoardKind, string> = {
  fact: "事实",
  decision: "决策",
  question: "问题",
  warning: "警告",
  artifact: "产物",
  link: "链接",
};
const MEMO_KIND_LABEL: Record<MemoKind, string> = {
  lesson: "教训",
  failure: "失败",
  shortcut: "捷径",
  preference: "偏好",
};
const CONFIDENCE_LABEL: Record<Confidence, string> = { low: "低", medium: "中", high: "高" };

export const MEMORY_TAB_HELP: Record<MemoryTab, { title: string; body: string }> = {
  board: {
    title: "黑板：团队共享的长期记忆",
    body: "发布事实、决策、警告与产物，让成员和下一轮任务都能检索；任务完成后先来这里沉淀。",
  },
  memo: {
    title: "备忘录：成员自己的经验",
    body: "查看当前成员在任务中写下的教训、失败与捷径；适合复盘个人方法，不替代团队黑板。",
  },
  archive: {
    title: "归档审批：让过时记忆退出",
    body: "处理系统按 TTL/陈旧度生成的下线提案；批准前请确认条目已过时，避免误删仍有效的决策。",
  },
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function loadTab(workspaceId: string): MemoryTab {
  try {
    const value = window.localStorage.getItem(`${TAB_KEY}${workspaceId}`);
    return value === "memo" || value === "archive" ? value : "board";
  } catch {
    return "board";
  }
}

function rememberTab(workspaceId: string, tab: MemoryTab): void {
  try {
    window.localStorage.setItem(`${TAB_KEY}${workspaceId}`, tab);
  } catch {
    // optional persistence
  }
}

function resultError<T>(result: MemoryResult<T>): string | null {
  return result.ok ? null : `${result.error.code}: ${result.error.message}`;
}

export interface MemoryWorkbenchProps {
  workspaceId: string;
  agents: Agent[];
  selectedBoard: string | null;
  onSelectBoard: (board: string) => void;
  autoOpenPublish: boolean;
  onAutoOpenHandled: () => void;
  onNotify: (message: string, kind?: NotifyKind) => void;
  /** t136：从黑板条目发起正式投票（入口保留来源）。 */
  onStartPoll?: (source: { title: string; sourceId: string; board: string }) => void;
}

export default function MemoryWorkbench({
  workspaceId,
  agents,
  selectedBoard,
  onSelectBoard,
  autoOpenPublish,
  onAutoOpenHandled,
  onNotify,
  onStartPoll,
}: MemoryWorkbenchProps) {
  const [tab, setTab] = useState<MemoryTab>(() => loadTab(workspaceId));
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"active" | "stale" | "archived">("active");
  const [kindFilter, setKindFilter] = useState<Set<BoardKind>>(new Set());
  const [memoAgent, setMemoAgent] = useState<string>(() => {
    const router = agents.find((agent) => agent.isRouter) ?? agents[0];
    return router?.id ?? "";
  });
  const [memoKindFilter, setMemoKindFilter] = useState<Set<MemoKind>>(new Set());
  const [memoSearch, setMemoSearch] = useState("");
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<Set<"board" | "memo" | "summary">>(new Set(["board", "memo", "summary"]));
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "verify"; entry: BoardEntry }
    | { kind: "ttl"; entry: BoardEntry }
    | { kind: "archive"; entry: BoardEntry }
    | { kind: "promote"; entry: BoardEntry }
    | { kind: "decide"; proposal: BoardArchiveProposal }
    | { kind: "memoPromote"; memo: Memo }
    | { kind: "memoVerify"; memo: Memo }
    | { kind: "memoArchive"; memo: Memo }
    | null
  >(null);
  const [actionBusy, setActionBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const tabRefs = useRef<Record<MemoryTab, HTMLButtonElement | null>>({ board: null, memo: null, archive: null });
  const requestRef = useRef(0);

  const routerId = agents.find((agent) => agent.isRouter)?.id ?? agents[0]?.id ?? "";
  const activeAgentId = memoAgent || routerId;

  const load = useCallback(
    async (announce = false) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      try {
        const options: MemorySnapshotOptions = {
          agentId: tab === "memo" ? activeAgentId : undefined,
          includeArchived: statusFilter === "archived" || tab === "archive",
          entriesLimit: 500,
          memosLimit: 200,
          proposalsLimit: 100,
        };
        const next = await window.deer.getMemorySnapshot(workspaceId, options);
        if (requestId !== requestRef.current) return;
        setSnapshot(next);
        setError(next.degradedReason);
        if (announce) setAnnouncement(`已刷新记忆：${next.counts.boardActive} 条活跃条目`);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [workspaceId, tab, activeAgentId, statusFilter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoOpenPublish) return;
    setTab("board");
    setPublishOpen(true);
    onAutoOpenHandled();
  }, [autoOpenPublish, onAutoOpenHandled]);

  useEffect(() => {
    rememberTab(workspaceId, tab);
  }, [workspaceId, tab]);

  useEffect(() => {
    return window.deer.onEvent((event) => {
      if (
        event.type.startsWith("board.") ||
        event.type.startsWith("memo.") ||
        event.type === "memory.sweep_completed" ||
        event.type === "memory.migrated"
      ) {
        void load();
      }
    });
  }, [load]);

  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of snapshot?.entries ?? []) {
      if (entry.status === "active") counts.set(entry.board, (counts.get(entry.board) ?? 0) + 1);
    }
    for (const domain of snapshot?.domains ?? []) {
      if (!counts.has(domain.name)) counts.set(domain.name, 0);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [snapshot]);

  const boardName =
    selectedBoard && domains.some(([name]) => name === selectedBoard)
      ? selectedBoard
      : (domains[0]?.[0] ?? "general");

  useEffect(() => {
    if (!selectedBoard && domains[0]) onSelectBoard(domains[0][0]);
  }, [selectedBoard, domains, onSelectBoard]);

  const entries = useMemo(() => {
    let list = (snapshot?.entries ?? []).filter((entry) => entry.board === boardName);
    list = list.filter((entry) => (statusFilter === "archived" ? entry.status === "archived" : entry.status === "active"));
    if (statusFilter === "stale") list = list.filter((entry) => entry.stale);
    if (kindFilter.size) list = list.filter((entry) => kindFilter.has(entry.kind));
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }, [snapshot, boardName, statusFilter, kindFilter]);

  const memos = useMemo(() => {
    let list = (snapshot?.memos ?? []).filter((memo) => memo.agentId === activeAgentId);
    if (memoKindFilter.size) list = list.filter((memo) => memoKindFilter.has(memo.kind));
    if (memoSearch.trim()) {
      const needle = memoSearch.trim().toLowerCase();
      list = list.filter(
        (memo) =>
          memo.content.toLowerCase().includes(needle) ||
          memo.tags.some((tag) => tag.toLowerCase().includes(needle)),
      );
    }
    return [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [snapshot, activeAgentId, memoKindFilter, memoSearch]);

  const pendingProposals = (snapshot?.proposals ?? []).filter((proposal) => proposal.status === "pending");
  const selectedAgent = agents.find((agent) => agent.id === activeAgentId);

  const act = async <T,>(operation: () => Promise<MemoryResult<T>>, success: string): Promise<boolean> => {
    setActionBusy(true);
    setAnnouncement(null);
    try {
      const result = await operation();
      const message = resultError(result);
      if (message) {
        setError(message);
        onNotify(message, "error");
        return false;
      }
      setError(null);
      setAnnouncement(success);
      onNotify(success, "success");
      await load();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onNotify(message, "error");
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const runSearch = async () => {
    if (!query.trim()) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const result = await window.deer.searchMemory({
        workspaceId,
        agentId: scopes.has("memo") ? activeAgentId : undefined,
        query: query.trim(),
        scopes: [...scopes],
        limit: 50,
        budgetTokens: 2000,
      });
      setSearchResult(result);
      setAnnouncement(`找到 ${result.total} 条记忆，已用 ${result.budget.usedTokens}/${result.budget.maxTokens} tokens`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const switchTab = (next: MemoryTab) => {
    setTab(next);
    setAnnouncement(null);
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: MemoryTab) => {
    const tabs: MemoryTab[] = ["board", "memo", "archive"];
    const index = tabs.indexOf(current);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      switchTab(next);
      tabRefs.current[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
      switchTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  const toggleKind = (kind: BoardKind) => {
    setKindFilter((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleMemoKind = (kind: MemoKind) => {
    setMemoKindFilter((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleScope = (scope: "board" | "memo" | "summary") => {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const copyCitation = async (citation: string) => {
    try {
      await navigator.clipboard?.writeText(citation);
      onNotify(`已复制引用 ${citation}`, "success");
    } catch {
      onNotify("复制失败，请手动选择引用", "error");
    }
  };

  return (
    <div className="memory-workbench">
      <section className="panel memory-panel" aria-label="记忆工作台">
        <header className="panel-head memory-head">
          <div>
            <div className="panel-title">记忆</div>
            <div className="muted tiny">黑板 · 备忘录 · 归档审批；人类治理，Agent 只写自己的备忘录</div>
          </div>
          <div className="memory-head-actions">
            <button type="button" className="ghost small" onClick={() => void load(true)} disabled={loading}>
              刷新
            </button>
            <button type="button" className="primary small" onClick={() => setPublishOpen(true)}>
              + 发布记忆条目
            </button>
          </div>
        </header>

        <div className="memory-tabs" role="tablist" aria-label="记忆视图">
          {(["board", "memo", "archive"] as MemoryTab[]).map((item) => (
            <button
              key={item}
              ref={(node) => {
                tabRefs.current[item] = node;
              }}
              type="button"
              role="tab"
              id={`memory-tab-${item}`}
              aria-selected={tab === item}
              aria-controls={`memory-panel-${item}`}
              tabIndex={tab === item ? 0 : -1}
              className={`memory-tab ${tab === item ? "active" : ""}`}
              onClick={() => switchTab(item)}
              onKeyDown={(event) => onTabKeyDown(event, item)}
            >
              {item === "board" ? "黑板" : item === "memo" ? "备忘录" : "归档审批"}
              {item === "archive" && pendingProposals.length > 0 ? (
                <span className="memory-count">{pendingProposals.length}</span>
              ) : null}
            </button>
          ))}
        </div>

        <p className="memory-tab-help" role="note" aria-live="polite">
          <strong>{MEMORY_TAB_HELP[tab].title}</strong>
          <span>{MEMORY_TAB_HELP[tab].body}</span>
        </p>

        <div className="memory-search-row">
          <label className="memory-search">
            <span className="muted tiny">检索记忆</span>
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runSearch();
                } else if (event.key === "Escape") {
                  setQuery("");
                  setSearchResult(null);
                }
              }}
              aria-label="检索记忆"
              placeholder="Enter 检索；Esc 清空"
            />
          </label>
          <div className="memory-scope-chips" role="group" aria-label="检索范围">
            {(["board", "memo", "summary"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                className={`chip ${scopes.has(scope) ? "active" : ""}`}
                aria-pressed={scopes.has(scope)}
                onClick={() => toggleScope(scope)}
              >
                {scope === "board" ? "黑板" : scope === "memo" ? "备忘录" : "摘要"}
              </button>
            ))}
            <button type="button" className="primary small" onClick={() => void runSearch()} disabled={searching}>
              {searching ? "检索中…" : "检索"}
            </button>
          </div>
        </div>

        <div className="memory-status" role="status" aria-live="polite">
          {loading && !snapshot
            ? "加载记忆…"
            : announcement ??
              (snapshot
                ? `${snapshot.counts.boardActive} 条活跃 · ${snapshot.counts.proposalsPending} 条待归档${
                    snapshot.ftsAvailable ? "" : " · 词法检索（LIKE 回退）"
                  }`
                : "")}
        </div>
        {error ? (
          <div className="memory-error" role="alert">
            <span>{error}</span>
            <button type="button" className="ghost small" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}

        {searchResult ? (
          <SearchResults
            result={searchResult}
            onClear={() => {
              setSearchResult(null);
              setQuery("");
              searchInputRef.current?.focus();
            }}
            onCopy={copyCitation}
          />
        ) : null}

        <div
          id={`memory-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`memory-tab-${tab}`}
          className="memory-tabpanel"
          aria-busy={loading}
        >
          {tab === "board" ? (
            <BoardTab
              entries={entries}
              domains={domains}
              boardName={boardName}
              statusFilter={statusFilter}
              kindFilter={kindFilter}
              onSelectBoard={onSelectBoard}
              onStatus={setStatusFilter}
              onToggleKind={toggleKind}
              onPublish={() => setPublishOpen(true)}
              onDialog={setDialog}
              onCopy={copyCitation}
              onStartPoll={onStartPoll}
              onPin={(entry, pinned) =>
                act(() => window.deer.setBoardPinned({ workspaceId, entryId: entry.id, pinned }), pinned ? "已置顶" : "已取消置顶")
              }
              loading={loading}
            />
          ) : tab === "memo" ? (
            <MemoTab
              agents={agents}
              selectedAgent={activeAgentId}
              onSelectAgent={setMemoAgent}
              memos={memos}
              memoKindFilter={memoKindFilter}
              memoSearch={memoSearch}
              onMemoSearch={setMemoSearch}
              onToggleKind={toggleMemoKind}
              onNew={() => setMemoOpen(true)}
              onGoBoard={() => switchTab("board")}
              onDialog={setDialog}
              loading={loading}
              privacyNote={
                selectedAgent
                  ? `仅 ${selectedAgent.name} 的备忘录可见；Router 与其他成员不会读取。`
                  : "选择成员查看其私有备忘录。"
              }
            />
          ) : (
            <ArchiveTab
              proposals={snapshot?.proposals ?? []}
              archivedEntries={(snapshot?.entries ?? []).filter((entry) => entry.status === "archived")}
              onDecide={(proposal) => setDialog({ kind: "decide", proposal })}
              onGoBoard={() => switchTab("board")}
              onRestore={(entry) =>
                act(() => window.deer.restoreBoardEntry({ workspaceId, entryId: entry.id }), "已恢复归档条目")
              }
              onMaintenance={async () => {
                setActionBusy(true);
                try {
                  const result = await window.deer.runMemoryMaintenance(workspaceId);
                  if (!result.ok) onNotify(`${result.error.code}: ${result.error.message}`, "error");
                  else {
                    onNotify("记忆维护完成", "success");
                    await load();
                  }
                } finally {
                  setActionBusy(false);
                }
              }}
              busy={actionBusy}
            />
          )}
        </div>
      </section>

      {publishOpen ? (
        <PublishModal
          domains={domains.map(([name]) => name)}
          defaultBoard={boardName}
          onClose={() => setPublishOpen(false)}
          onSubmit={async (input) => {
            const ok = await act(
              () => window.deer.createMemoryBoard({ workspaceId, ...input }),
              "已发布记忆条目",
            );
            if (ok) {
              onSelectBoard(input.board);
              setPublishOpen(false);
            }
          }}
        />
      ) : null}

      {memoOpen ? (
        <MemoModal
          agents={agents}
          defaultAgentId={activeAgentId}
          onClose={() => setMemoOpen(false)}
          onSubmit={async (input) => {
            const ok = await act(
              () => window.deer.createMemoryMemo({ workspaceId, ...input }),
              "已创建备忘录",
            );
            if (ok) {
              setMemoAgent(input.agentId);
              setMemoOpen(false);
            }
          }}
        />
      ) : null}

      {dialog ? (
        <ActionDialog
          dialog={dialog}
          busy={actionBusy}
          onClose={() => setDialog(null)}
          onVerify={(entry, confidence) =>
            act(() => window.deer.verifyBoardEntry({ workspaceId, entryId: entry.id, confidence }), "已复核条目")
          }
          onTtl={(entry, ttlDays) =>
            act(() => window.deer.setBoardTtl({ workspaceId, entryId: entry.id, ttlDays }), "已更新 TTL")
          }
          onArchive={(entry, reason, note) =>
            act(() => window.deer.proposeBoardArchive({ workspaceId, entryId: entry.id, reason, note }), "已提交归档建议")
          }
          onPromote={(entry) =>
            act(() => window.deer.promoteBoardEntry({ workspaceId, entryId: entry.id, kind: "decision" }), "已提升为决策")
          }
          onDecide={(proposal, decision, note) =>
            act(
              () => window.deer.decideBoardArchive({ workspaceId, proposalId: proposal.id, decision, note }),
              decision === "approve" ? "已批准归档" : "已拒绝归档",
            )
          }
          onMemoVerify={(memo) =>
            act(
              () => window.deer.verifyMemoryMemo({ workspaceId, agentId: memo.agentId, memoId: memo.id }),
              "已复核备忘录",
            )
          }
          onMemoArchive={(memo) =>
            act(
              () => window.deer.archiveMemoryMemo({ workspaceId, agentId: memo.agentId, memoId: memo.id }),
              "已归档备忘录",
            )
          }
          onMemoPromote={(memo, board) =>
            act(
              () => window.deer.promoteMemoryMemo({ workspaceId, agentId: memo.agentId, memoId: memo.id, board }),
              "备忘录已提升到黑板",
            )
          }
        />
      ) : null}
    </div>
  );
}

function SearchResults({
  result,
  onClear,
  onCopy,
}: {
  result: MemorySearchResult;
  onClear: () => void;
  onCopy: (citation: string) => void;
}) {
  return (
    <section className="memory-results" aria-label="记忆检索结果">
      <div className="row between memory-results-head">
        <div role="status" aria-live="polite">
          找到 {result.hits.length}/{result.total} 条 · 已用 {result.budget.usedTokens}/{result.budget.maxTokens} tokens
          {result.budget.truncated ? ` · 已截断，省略 ${result.budget.omitted}` : ""}
        </div>
        <button type="button" className="ghost small" onClick={onClear}>
          清除检索
        </button>
      </div>
      {result.hits.length === 0 ? (
        <EmptyState compact title="没有匹配的记忆" description="清除检索或换一个关键词。" />
      ) : (
        <div className="memory-result-list" role="list">
          {result.hits.map((hit) => (
            <details key={`${hit.entityType}:${hit.id}`} className="memory-result" role="listitem">
              <summary>
                <span className="badge">{hit.entityType === "board" ? "黑板" : hit.entityType === "memo" ? "备忘录" : "摘要"}</span>
                <span>{hit.title}</span>
                <span className="muted tiny">score {hit.score.toFixed(2)}</span>
                {hit.stale ? <span className="badge warning">stale</span> : null}
              </summary>
              <p>{hit.snippet}</p>
              <div className="memory-score-grid muted tiny">
                <span>相关度 {hit.breakdown.relevance.toFixed(2)}</span>
                <span>置信度 {hit.breakdown.confidence.toFixed(2)}</span>
                <span>新鲜度 {hit.breakdown.freshness.toFixed(2)}</span>
                <span>pin {hit.breakdown.pinBoost.toFixed(2)}</span>
                <span>verified {hit.breakdown.verifiedBoost.toFixed(2)}</span>
              </div>
              <div className="memory-card-actions">
                {hit.citations.map((citation) => (
                  <button key={citation} type="button" className="ghost small" onClick={() => onCopy(citation)}>
                    {citation}
                  </button>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function BoardTab({
  entries,
  domains,
  boardName,
  statusFilter,
  kindFilter,
  onSelectBoard,
  onStatus,
  onToggleKind,
  onPublish,
  onDialog,
  onCopy,
  onStartPoll,
  onPin,
  loading,
}: {
  entries: BoardEntry[];
  domains: Array<[string, number]>;
  boardName: string;
  statusFilter: "active" | "stale" | "archived";
  kindFilter: Set<BoardKind>;
  onSelectBoard: (board: string) => void;
  onStatus: (status: "active" | "stale" | "archived") => void;
  onToggleKind: (kind: BoardKind) => void;
  onPublish: () => void;
  onDialog: (dialog: { kind: "verify" | "ttl" | "archive" | "promote"; entry: BoardEntry }) => void;
  onCopy: (citation: string) => void;
  onStartPoll?: (source: { title: string; sourceId: string; board: string }) => void;
  onPin: (entry: BoardEntry, pinned: boolean) => Promise<boolean>;
  loading: boolean;
}) {
  return (
    <>
      <div className="memory-domain-tabs" role="group" aria-label="黑板领域">
        {domains.map(([domain, count]) => (
          <button
            key={domain}
            type="button"
            aria-pressed={domain === boardName}
            className={`chip ${domain === boardName ? "active" : ""}`}
            onClick={() => onSelectBoard(domain)}
          >
            {domain} <span className="memory-count">{count}</span>
          </button>
        ))}
        {domains.length === 0 ? <span className="muted tiny">还没有黑板领域；发布第一条后自动创建。</span> : null}
      </div>
      <div className="memory-filters">
        <label>
          状态
          <select value={statusFilter} onChange={(event) => onStatus(event.target.value as typeof statusFilter)}>
            <option value="active">活跃</option>
            <option value="stale">待复核</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <div className="memory-kind-chips" role="group" aria-label="类型筛选">
          {(["fact", "decision", "question", "warning", "artifact", "link"] as BoardKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip ${kindFilter.has(kind) ? "active" : ""}`}
              aria-pressed={kindFilter.has(kind)}
              onClick={() => onToggleKind(kind)}
            >
              {BOARD_KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </div>
      {loading && entries.length === 0 ? <p className="muted">加载中…</p> : null}
      {!loading && entries.length === 0 ? (
        <EmptyState
          title={domains.length === 0 ? "还没有记忆条目" : "这个领域还没有条目"}
          description="发布一条原子化的事实、决策、问题或产物，与团队共享上下文。"
          actions={[{ label: "+ 发布记忆条目", onClick: onPublish, primary: true }]}
        />
      ) : null}
      <div className="memory-list">
        {entries.map((entry) => (
          <article key={entry.id} className="memory-card" aria-label={`${BOARD_KIND_LABEL[entry.kind]} ${entry.board}`}>
            <div className="memory-card-head">
              <span className="badge">{BOARD_KIND_LABEL[entry.kind]}</span>
              <span className="muted tiny">{entry.board}</span>
              <span className="badge">{CONFIDENCE_LABEL[entry.confidence]}</span>
              {entry.pinned ? <span className="badge pinned">置顶</span> : null}
              {entry.status === "archived" ? <span className="badge muted">已归档</span> : null}
              {entry.stale && entry.status === "active" ? <span className="badge warning">30 天未复核</span> : null}
              {entry.ttlAt ? <span className="muted tiny">TTL {formatTime(entry.ttlAt)}</span> : null}
              {entry.lastVerifiedAt ? <span className="muted tiny">已复核 {formatTime(entry.lastVerifiedAt)}</span> : null}
            </div>
            <div className="memory-card-body">
              <Markdown content={entry.content} />
            </div>
            <div className="memory-card-meta muted tiny">
              来源：{entry.source} · {entry.author} · {formatTime(entry.createdAt)}
              {entry.refs.length ? ` · 引用 ${entry.refs.length}` : ""}
            </div>
            <div className="memory-card-actions">
              <button
                type="button"
                className="ghost small"
                aria-pressed={entry.pinned}
                onClick={() => void onPin(entry, !entry.pinned)}
              >
                {entry.pinned ? "取消置顶" : "置顶"}
              </button>
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "verify", entry })}>
                复核
              </button>
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "ttl", entry })}>
                设置 TTL
              </button>
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "promote", entry })}>
                提升为决策
              </button>
              {onStartPoll ? (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() =>
                    onStartPoll({
                      title: entry.content.slice(0, 80),
                      sourceId: entry.id,
                      board: entry.board,
                    })
                  }
                >
                  发起投票
                </button>
              ) : null}
              <button
                type="button"
                className="ghost small"
                disabled={entry.pinned || entry.status !== "active"}
                title={entry.pinned ? "置顶条目不能归档" : undefined}
                onClick={() => onDialog({ kind: "archive", entry })}
              >
                建议归档
              </button>
              <button type="button" className="ghost small" onClick={() => onCopy(`board:${entry.id}`)}>
                复制引用
              </button>
              {entry.promotedToId ? <span className="muted tiny">已提升</span> : null}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function MemoTab({
  agents,
  selectedAgent,
  onSelectAgent,
  memos,
  memoKindFilter,
  memoSearch,
  onMemoSearch,
  onToggleKind,
  onNew,
  onGoBoard,
  onDialog,
  loading,
  privacyNote,
}: {
  agents: Agent[];
  selectedAgent: string;
  onSelectAgent: (agentId: string) => void;
  memos: Memo[];
  memoKindFilter: Set<MemoKind>;
  memoSearch: string;
  onMemoSearch: (value: string) => void;
  onToggleKind: (kind: MemoKind) => void;
  onNew: () => void;
  onGoBoard: () => void;
  onDialog: (dialog: { kind: "memoVerify" | "memoArchive" | "memoPromote"; memo: Memo }) => void;
  loading: boolean;
  privacyNote: string;
}) {
  return (
    <>
      <div className="memory-memo-toolbar">
        <label>
          成员
          <select value={selectedAgent} onChange={(event) => onSelectAgent(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}{agent.isRouter ? "（Router）" : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="muted tiny" role="note">{privacyNote}</p>
        <button type="button" className="primary small" onClick={onNew}>
          + 新建备忘录
        </button>
      </div>
      <div className="memory-filters">
        <label>
          搜索
          <input
            type="search"
            value={memoSearch}
            onChange={(event) => onMemoSearch(event.target.value)}
            aria-label="搜索当前成员备忘录"
          />
        </label>
        <div className="memory-kind-chips" role="group" aria-label="备忘录类型">
          {(["lesson", "failure", "shortcut", "preference"] as MemoKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip ${memoKindFilter.has(kind) ? "active" : ""}`}
              aria-pressed={memoKindFilter.has(kind)}
              onClick={() => onToggleKind(kind)}
            >
              {MEMO_KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </div>
      {loading && memos.length === 0 ? <p className="muted">加载中…</p> : null}
      {!loading && memos.length === 0 ? (
        <EmptyState
          compact
          title="该成员还没有备忘录"
          description="Agent 可通过 memo.write 写入自己的经验；人类也可显式代写。"
          actions={[
            { label: "新建备忘录", onClick: onNew, primary: true },
            { label: "去黑板发布", onClick: onGoBoard },
          ]}
        />
      ) : null}
      <div className="memory-list">
        {memos.map((memo) => (
          <article key={memo.id} className="memory-card" aria-label={`备忘录 ${MEMO_KIND_LABEL[memo.kind]}`}>
            <div className="memory-card-head">
              <span className="badge">{MEMO_KIND_LABEL[memo.kind]}</span>
              {memo.tags.map((tag) => <span key={tag} className="badge muted">#{tag}</span>)}
              {memo.stale ? <span className="badge warning">30 天未复核</span> : null}
              {memo.expiresAt && Date.parse(memo.expiresAt) <= Date.now() ? <span className="badge warning">已过期</span> : null}
              {memo.status === "archived" ? <span className="badge muted">已归档</span> : null}
            </div>
            <p className="memory-card-text">{memo.content}</p>
            <div className="memory-card-meta muted tiny">
              来源 {memo.source}{memo.sourceTaskId ? ` · task:${memo.sourceTaskId}` : ""}
              {memo.expiresAt ? ` · ${formatTime(memo.expiresAt)} 到期` : ""}
              {memo.lastVerifiedAt ? ` · 复核 ${formatTime(memo.lastVerifiedAt)}` : ""}
            </div>
            <div className="memory-card-actions">
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "memoVerify", memo })}>
                复核
              </button>
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "memoPromote", memo })}>
                提升到黑板
              </button>
              <button type="button" className="ghost small" onClick={() => onDialog({ kind: "memoArchive", memo })}>
                归档
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function ArchiveTab({
  proposals,
  archivedEntries,
  onDecide,
  onRestore,
  onMaintenance,
  onGoBoard,
  busy,
}: {
  proposals: BoardArchiveProposal[];
  archivedEntries: BoardEntry[];
  onDecide: (proposal: BoardArchiveProposal) => void;
  onRestore: (entry: BoardEntry) => Promise<boolean>;
  onMaintenance: () => void;
  onGoBoard: () => void;
  busy: boolean;
}) {
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  return (
    <>
      <div className="memory-archive-head">
        <div>
          <strong>待审批 {pending.length}</strong>
          <p className="muted tiny">30 天未处理将过期；pinned 条目不会被自动建议归档。审批人类专属。</p>
        </div>
        <button type="button" className="ghost small" onClick={onMaintenance} disabled={busy}>
          检查过期条目
        </button>
      </div>
      {pending.length === 0 ? (
        <EmptyState
          compact
          title="没有待归档提案"
          description="系统会按 TTL/陈旧度生成建议；也可在条目上手动建议归档。"
          actions={[{ label: "去黑板查看条目", onClick: onGoBoard, primary: true }]}
        />
      ) : (
        <div className="memory-list">
          {pending.map((proposal) => {
            const snapshot = proposal.entrySnapshot;
            return (
              <article key={proposal.id} className="memory-card" aria-label="待归档提案">
                <div className="memory-card-head">
                  <span className="badge">归档建议</span>
                  <span className="muted tiny">{proposal.reason === "ttl_expired" ? "TTL 到期" : proposal.reason === "stale" ? "30 天未复核" : "手动"}</span>
                  <span className="muted tiny">{proposal.proposedBy} · {formatTime(proposal.proposedAt)}</span>
                </div>
                {snapshot ? (
                  <>
                    <Markdown content={snapshot.contentPreview} />
                    <div className="muted tiny">
                      {BOARD_KIND_LABEL[snapshot.kind]} · {snapshot.board} · 置信度 {CONFIDENCE_LABEL[snapshot.confidence]}
                      {snapshot.pinned ? " · 置顶" : ""}{snapshot.ttlAt ? ` · TTL ${formatTime(snapshot.ttlAt)}` : ""}
                    </div>
                  </>
                ) : (
                  <p className="muted">旧提案无快照；以当前条目为准。</p>
                )}
                {proposal.note ? <p className="muted tiny">备注：{proposal.note}</p> : null}
                <div className="memory-card-actions">
                  <button type="button" className="ghost small" onClick={() => onDecide(proposal)}>
                    审批
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {proposals.some((proposal) => proposal.status !== "pending") ? (
        <p className="muted tiny">已处理历史：{proposals.filter((proposal) => proposal.status !== "pending").length} 条。</p>
      ) : null}
      {archivedEntries.length > 0 ? (
        <>
          <h3 className="memory-subhead">已归档条目</h3>
          <div className="memory-list">
            {archivedEntries.map((entry) => (
              <article key={entry.id} className="memory-card" aria-label="已归档条目">
                <div className="memory-card-head">
                  <span className="badge">{BOARD_KIND_LABEL[entry.kind]}</span>
                  <span className="muted tiny">{entry.board} · {formatTime(entry.archivedAt)}</span>
                  <span className="badge muted">已归档</span>
                </div>
                <p className="memory-card-text">{entry.content}</p>
                <div className="memory-card-actions">
                  <button type="button" className="ghost small" onClick={() => void onRestore(entry)}>
                    恢复
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function PublishModal({
  domains,
  defaultBoard,
  onClose,
  onSubmit,
}: {
  domains: string[];
  defaultBoard: string;
  onClose: () => void;
  onSubmit: (input: {
    board: string;
    kind: BoardKind;
    content: string;
    confidence: Confidence;
    ttlDays: number | null;
    refs: string[];
  }) => Promise<void>;
}) {
  const [board, setBoard] = useState(defaultBoard);
  const [kind, setKind] = useState<BoardKind>("fact");
  const [confidence, setConfidence] = useState<Confidence>("medium");
  const [content, setContent] = useState("");
  const [ttl, setTtl] = useState("");
  const [refs, setRefs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dirty = Boolean(content.trim()) || board !== defaultBoard || kind !== "fact" || confidence !== "medium";
  return (
    <Modal title="发布记忆条目" description="原子化、可追溯；来源由主进程标记为 user" onClose={onClose} confirmClose={dirty}>
      <form
        className="form modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!content.trim()) return;
          setSubmitting(true);
          try {
            await onSubmit({
              board: board.trim() || "general",
              kind,
              content: content.trim(),
              confidence,
              ttlDays: ttl.trim() ? Number(ttl) : null,
              refs: refs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 20),
            });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label>
          领域
          <input list="memory-domains" value={board} onChange={(event) => setBoard(event.target.value)} maxLength={80} required />
          <datalist id="memory-domains">
            {domains.map((domain) => <option key={domain} value={domain} />)}
          </datalist>
        </label>
        <div className="provider-grid">
          <label>
            类型
            <select value={kind} onChange={(event) => setKind(event.target.value as BoardKind)}>
              {(Object.keys(BOARD_KIND_LABEL) as BoardKind[]).map((item) => (
                <option key={item} value={item}>{BOARD_KIND_LABEL[item]}</option>
              ))}
            </select>
          </label>
          <label>
            置信度
            <select value={confidence} onChange={(event) => setConfidence(event.target.value as Confidence)}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
          <label>
            TTL（天，可空）
            <input type="number" min={1} max={365} value={ttl} onChange={(event) => setTtl(event.target.value)} />
          </label>
        </div>
        <label>
          内容（≤2000）
          <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} rows={5} required />
        </label>
        <label>
          引用（一行一条，≤20）
          <textarea value={refs} onChange={(event) => setRefs(event.target.value)} rows={3} />
        </label>
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={submitting || !content.trim()}>
            {submitting ? "发布中…" : "发布"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MemoModal({
  agents,
  defaultAgentId,
  onClose,
  onSubmit,
}: {
  agents: Agent[];
  defaultAgentId: string;
  onClose: () => void;
  onSubmit: (input: {
    agentId: string;
    kind: MemoKind;
    content: string;
    tags: string[];
    confidence: Confidence;
    expiresInDays: number | null;
  }) => Promise<void>;
}) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [kind, setKind] = useState<MemoKind>("lesson");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [expiry, setExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <Modal title="新建备忘录" description="人类显式代写给选定成员；私密，仅该成员上下文可见" onClose={onClose} confirmClose={Boolean(content.trim())}>
      <form
        className="form modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!content.trim()) return;
          setSubmitting(true);
          try {
            await onSubmit({
              agentId,
              kind,
              content: content.trim(),
              tags: tags.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 10),
              confidence: "medium",
              expiresInDays: expiry.trim() ? Number(expiry) : null,
            });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label>
          成员
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}{agent.isRouter ? "（Router）" : ""}</option>
            ))}
          </select>
        </label>
        <div className="provider-grid">
          <label>
            类型
            <select value={kind} onChange={(event) => setKind(event.target.value as MemoKind)}>
              {(Object.keys(MEMO_KIND_LABEL) as MemoKind[]).map((item) => (
                <option key={item} value={item}>{MEMO_KIND_LABEL[item]}</option>
              ))}
            </select>
          </label>
          <label>
            过期（天，可空）
            <input type="number" min={1} max={365} value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </label>
        </div>
        <label>
          内容（≤2000）
          <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} rows={5} required />
        </label>
        <label>
          标签（逗号分隔，≤10）
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={submitting || !content.trim()}>
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ActionDialog({
  dialog,
  busy,
  onClose,
  onVerify,
  onTtl,
  onArchive,
  onPromote,
  onDecide,
  onMemoVerify,
  onMemoArchive,
  onMemoPromote,
}: {
  dialog:
    | { kind: "verify"; entry: BoardEntry }
    | { kind: "ttl"; entry: BoardEntry }
    | { kind: "archive"; entry: BoardEntry }
    | { kind: "promote"; entry: BoardEntry }
    | { kind: "decide"; proposal: BoardArchiveProposal }
    | { kind: "memoPromote"; memo: Memo }
    | { kind: "memoVerify"; memo: Memo }
    | { kind: "memoArchive"; memo: Memo };
  busy: boolean;
  onClose: () => void;
  onVerify: (entry: BoardEntry, confidence: Confidence) => Promise<boolean>;
  onTtl: (entry: BoardEntry, ttlDays: number | null) => Promise<boolean>;
  onArchive: (entry: BoardEntry, reason: "manual" | "stale", note: string) => Promise<boolean>;
  onPromote: (entry: BoardEntry) => Promise<boolean>;
  onDecide: (proposal: BoardArchiveProposal, decision: "approve" | "reject", note: string) => Promise<boolean>;
  onMemoVerify: (memo: Memo) => Promise<boolean>;
  onMemoArchive: (memo: Memo) => Promise<boolean>;
  onMemoPromote: (memo: Memo, board: string) => Promise<boolean>;
}) {
  const [confidence, setConfidence] = useState<Confidence>("medium");
  const [ttl, setTtl] = useState("");
  const [reason, setReason] = useState<"manual" | "stale">("manual");
  const [note, setNote] = useState("");
  const [board, setBoard] = useState("general");
  const [decision, setDecision] = useState<"approve" | "reject">("approve");

  const submit = async () => {
    let ok = false;
    if (dialog.kind === "verify") ok = await onVerify(dialog.entry, confidence);
    else if (dialog.kind === "ttl") ok = await onTtl(dialog.entry, ttl.trim() ? Number(ttl) : null);
    else if (dialog.kind === "archive") ok = await onArchive(dialog.entry, reason, note.trim());
    else if (dialog.kind === "promote") ok = await onPromote(dialog.entry);
    else if (dialog.kind === "decide") ok = await onDecide(dialog.proposal, decision, note.trim());
    else if (dialog.kind === "memoVerify") ok = await onMemoVerify(dialog.memo);
    else if (dialog.kind === "memoArchive") ok = await onMemoArchive(dialog.memo);
    else if (dialog.kind === "memoPromote") ok = await onMemoPromote(dialog.memo, board.trim() || "general");
    if (ok) onClose();
  };

  const title =
    dialog.kind === "verify" ? "复核条目" :
    dialog.kind === "ttl" ? "设置 TTL" :
    dialog.kind === "archive" ? "建议归档" :
    dialog.kind === "promote" ? "提升为决策" :
    dialog.kind === "decide" ? "审批归档建议" :
    dialog.kind === "memoVerify" ? "复核备忘录" :
    dialog.kind === "memoArchive" ? "归档备忘录" : "提升备忘录到黑板";

  return (
    <Modal title={title} onClose={onClose}>
      {dialog.kind === "verify" ? (
        <div className="form modal-form">
          <label>
            置信度
            <select value={confidence} onChange={(event) => setConfidence(event.target.value as Confidence)}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
          <p className="muted tiny">复核会清除 stale 并记录 verifiedBy/时间。</p>
        </div>
      ) : null}
      {dialog.kind === "ttl" ? (
        <div className="form modal-form">
          <label>
            TTL 天数（留空 = 永不过期）
            <input
              type="number"
              min={1}
              max={365}
              value={ttl}
              aria-label="TTL 天数"
              aria-describedby="ttl-help"
              onChange={(event) => setTtl(event.target.value)}
            />
          </label>
          <p className="muted tiny" id="ttl-help">到期只会生成归档建议，不会自动删除。</p>
        </div>
      ) : null}
      {dialog.kind === "archive" ? (
        <div className="form modal-form">
          <label>
            原因
            <select value={reason} onChange={(event) => setReason(event.target.value as "manual" | "stale")}>
              <option value="manual">手动</option>
              <option value="stale">30 天未复核</option>
            </select>
          </label>
          <label>
            备注（可选）
            <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} rows={3} />
          </label>
        </div>
      ) : null}
      {dialog.kind === "promote" ? (
        <p>确认把该条目提升为新的 decision？原条目保留并记录已提升。</p>
      ) : null}
      {dialog.kind === "decide" ? (
        <div className="form modal-form">
          <label>
            决定
            <select value={decision} onChange={(event) => setDecision(event.target.value as "approve" | "reject")}>
              <option value="approve">批准归档</option>
              <option value="reject">拒绝</option>
            </select>
          </label>
          <label>
            备注（可选）
            <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} rows={3} />
          </label>
        </div>
      ) : null}
      {dialog.kind === "memoVerify" ? <p>复核会清除该备忘录的 stale 标记。</p> : null}
      {dialog.kind === "memoArchive" ? <p>归档后备忘录保留，但不再出现在当前成员默认列表。</p> : null}
      {dialog.kind === "memoPromote" ? (
        <div className="form modal-form">
          <label>
            目标黑板
            <input value={board} onChange={(event) => setBoard(event.target.value)} maxLength={80} />
          </label>
          <p className="muted tiny">会创建一条 decision 黑板条目并关联，原备忘录保留。</p>
        </div>
      ) : null}
      <div className="modal-foot">
        <button type="button" className="ghost" onClick={onClose}>取消</button>
        <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "处理中…" : "确认"}
        </button>
      </div>
    </Modal>
  );
}
