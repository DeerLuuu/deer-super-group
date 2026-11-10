import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ReviewComment,
  ReviewDecision,
  ReviewDiffPage,
  ReviewSeverity,
  ReviewSummary,
  ReviewThread,
} from "../types.js";

interface ReviewSectionProps {
  taskId: string;
  onNotify?: (message: string) => void;
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

function severityLabel(severity: ReviewSeverity): string {
  return severity === "blocker" ? "阻断" : severity === "issue" ? "问题" : severity === "suggestion" ? "建议" : "小问题";
}

function threadLine(thread: ReviewThread): string {
  return `${thread.filePath}:${thread.side === "old" ? "旧" : ""}${thread.lineStart}`;
}

function redact(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/(token|secret|password)=([^&\s]+)/gi, "$1=***");
}

export default function ReviewSection({ taskId, onNotify }: ReviewSectionProps) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<ReviewDiffPage | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ line: number; side: "new" | "old" } | null>(null);
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [commentBody, setCommentBody] = useState("");
  const [commentSeverity, setCommentSeverity] = useState<ReviewSeverity>("suggestion");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [decisionNotes, setDecisionNotes] = useState("");

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.deer.getReviewSummary(taskId);
      setSummary(next);
      setError(null);
      setSelectedFile((current) => {
        if (current && next.files.some((file) => file.path === current)) return current;
        return next.files[0]?.path ?? null;
      });
      setThreads(await window.deer.getReviewThreads({ taskId, status: "all" }));
    } catch (err) {
      setSummary(null);
      setDiff(null);
      setThreads([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const loadFile = useCallback(async (file: string) => {
    setBusy(true);
    try {
      const page = await window.deer.getReviewDiff({ taskId, file, offset: 0, limit: 300 });
      setDiff(page);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [taskId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (selectedFile) void loadFile(selectedFile);
  }, [selectedFile, loadFile]);

  useEffect(() => {
    const first = diff?.lines[0];
    setActiveLine(first ? `${first.kind}-${first.oldLine}-${first.newLine}-${first.hunk}` : null);
    setWindowStart(0);
  }, [diff?.file.path]);

  const refreshThreads = async () => {
    setThreads(await window.deer.getReviewThreads({ taskId, status: "all" }));
  };

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    onNotify?.(message);
  };

  const submitComment = async () => {
    if (!composer || !selectedFile) return;
    setBusy(true);
    try {
      await window.deer.createReviewThread({
        taskId,
        filePath: selectedFile,
        side: composer.side,
        lineStart: composer.line,
        lineEnd: composer.line,
        body: commentBody,
        severity: commentSeverity,
      });
      setCommentBody("");
      setComposer(null);
      await loadSummary();
      onNotify?.("评论已发布");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const reply = async (threadId: string) => {
    if (!replyBody.trim()) return;
    setBusy(true);
    try {
      await window.deer.replyReviewThread({ taskId, threadId, body: replyBody });
      setReplyBody("");
      setReplyTo(null);
      await refreshThreads();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (thread: ReviewThread) => {
    setBusy(true);
    try {
      if (thread.status === "resolved") {
        await window.deer.reopenReviewThread({ taskId, threadId: thread.id });
      } else {
        await window.deer.resolveReviewThread({ taskId, threadId: thread.id });
      }
      await loadSummary();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const removeReviewer = async (reviewerId: string) => {
    setBusy(true);
    try {
      await window.deer.removeReviewer({ taskId, reviewerId, reason: "ui reviewer removal" });
      await loadSummary();
      onNotify?.("评审人已移除");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: ReviewDecision) => {
    if (!summary) return;
    if (decision === "request_changes" && !decisionNotes.trim()) {
      setError("要求修改必须填写备注");
      return;
    }
    setBusy(true);
    try {
      await window.deer.submitReviewDecision({
        taskId,
        decision,
        headSha: summary.target.headSha,
        notes: decisionNotes.trim() || undefined,
      });
      setDecisionNotes("");
      setError(null);
      await loadSummary();
      onNotify?.(decision === "approve" ? "评审已通过" : "已要求修改");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const blockers = summary?.target.blockerCount ?? 0;
  const currentDecision = useMemo(
    () => summary?.decisions.find((decision) => decision.isCurrent) ?? null,
    [summary],
  );
  const hasReviewer = summary?.target.reviewers.some((reviewer) => reviewer.status !== "removed") ?? false;
  const canDecide =
    summary?.mode !== "off" &&
    summary?.target.status !== "stale" &&
    blockers === 0 &&
    hasReviewer;
  const diffLines = diff?.lines ?? [];
  const visibleStart = Math.min(windowStart, Math.max(0, diffLines.length - 1));
  const visibleLines = diffLines.slice(visibleStart, visibleStart + 200);

  const openComposerAt = (lineNo: number, side: "new" | "old") => {
    setComposer({ line: lineNo, side });
    setCommentBody("");
  };

  const moveDiffFocus = (current: HTMLElement, delta: number) => {
    const rows = Array.from(current.parentElement?.querySelectorAll<HTMLElement>("[data-review-line]") ?? []);
    const index = rows.indexOf(current);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    next?.focus();
  };

  return (
    <section className="review-section" aria-label="行级评审" aria-busy={loading || busy}>
      <header className="review-head">
        <div>
          <h3>行级评审</h3>
          <p className="muted tiny">
            {summary ? `head ${shortSha(summary.target.headSha)} · base ${summary.target.baseBranch} · ${summary.mode}` : "合并前代码评审"}
          </p>
        </div>
        <div className="row gap wrap">
          {summary ? (
            <span className={`badge ${summary.target.status === "approved" ? "ok" : summary.target.status === "changes_requested" ? "warn" : "muted"}`}>
              {summary.target.status === "approved" ? "已通过" : summary.target.status === "changes_requested" ? "要求修改" : "待评审"}
            </span>
          ) : null}
          <button type="button" className="ghost small" onClick={() => void loadSummary()} disabled={loading || busy}>
            刷新
          </button>
        </div>
      </header>

      {loading ? (
        <p role="status" aria-live="polite" className="muted small">
          加载评审…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="review-error">
          <span>{error}</span>
          <button type="button" className="ghost tiny" onClick={() => void loadSummary()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && !summary ? (
        <p className="muted small">尚无 PR/head；任务运行并创建 PR 后可开始评审。</p>
      ) : null}

      {summary ? (
        <>
          <div className="review-reviewers row gap wrap" aria-label="评审人">
            {summary.target.reviewers.map((reviewer) => (
              <span key={reviewer.id} className="badge muted">
                {reviewer.reviewerId} · {reviewer.status}
                {reviewer.status !== "removed" ? (
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => void removeReviewer(reviewer.reviewerId)}
                    aria-label={`移除评审人 ${reviewer.reviewerId}`}
                  >
                    移除
                  </button>
                ) : null}
              </span>
            ))}
            <span className="muted tiny">审批 {summary.target.approvalCount}/1 · blocker {blockers}</span>
          </div>

          <div className="review-layout">
            <nav className="review-files" aria-label="评审文件">
              {summary.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`review-file ${selectedFile === file.path ? "active" : ""}`}
                  aria-pressed={selectedFile === file.path}
                  onClick={() => setSelectedFile(file.path)}
                >
                  <span className="mono">{file.path}</span>
                  <span className="muted tiny">
                    {file.isBinary ? "binary" : `+${file.additions} -${file.deletions}`}
                  </span>
                </button>
              ))}
            </nav>

            <div className="review-diff-panel">
              {diff ? (
                <>
                  <div className="review-file-head">
                    <span className="mono">{diff.file.path}</span>
                    {diff.file.truncated ? <span className="badge warn">大 diff 已截断</span> : null}
                  </div>
                  {diff.file.isBinary ? (
                    <p className="muted small">二进制文件不显示 diff。</p>
                  ) : (
                    <div className="review-diff" role="grid" aria-label={`${diff.file.path} diff`} aria-rowcount={diffLines.length} aria-colcount={4}>
                      {visibleLines.map((line, visibleIndex) => {
                        const lineNo = line.newLine ?? line.oldLine ?? 0;
                        const side = line.newLine != null ? "new" : "old";
                        const lineKey = `${line.kind}-${line.oldLine}-${line.newLine}-${line.hunk}`;
                        return (
                          <div
                            key={lineKey}
                            data-review-line={lineKey}
                            tabIndex={activeLine === lineKey ? 0 : -1}
                            onFocus={() => setActiveLine(lineKey)}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowDown") {
                                event.preventDefault();
                                moveDiffFocus(event.currentTarget, 1);
                              } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                moveDiffFocus(event.currentTarget, -1);
                              } else if (event.key === "Enter") {
                                event.preventDefault();
                                openComposerAt(lineNo, side);
                              }
                            }}
                            className={`review-line ${line.kind}`}
                            role="row"
                            aria-posinset={visibleStart + visibleIndex + 1}
                            aria-rowindex={visibleStart + visibleIndex + 1}
                            aria-setsize={diffLines.length}
                            aria-label={`${line.kind === "add" ? "新增" : line.kind === "del" ? "删除" : "上下文"}行 ${lineNo}`}
                          >
                            <span className="review-line-no" role="gridcell">{line.oldLine ?? ""}</span>
                            <span className="review-line-no" role="gridcell">{line.newLine ?? ""}</span>
                            <span className="review-line-text" role="gridcell">{redact(line.text) || " "}</span>
                            <button
                              type="button"
                              role="gridcell"
                              className="ghost tiny review-line-comment"
                              aria-label={`评论第 ${lineNo} 行`}
                              onClick={() => openComposerAt(lineNo, side)}
                            >
                              评论
                            </button>
                          </div>
                        );
                      })}
                      {diffLines.length > 200 ? (
                        <div className="row gap review-virtual-nav">
                          <button
                            type="button"
                            className="ghost tiny"
                            disabled={visibleStart === 0}
                            onClick={() => setWindowStart(Math.max(0, visibleStart - 200))}
                          >
                            上一页
                          </button>
                          <span className="muted tiny">
                            {visibleStart + 1}–{Math.min(diffLines.length, visibleStart + 200)} / {diffLines.length}
                          </span>
                          <button
                            type="button"
                            className="ghost tiny"
                            disabled={visibleStart + 200 >= diffLines.length}
                            onClick={() => setWindowStart(visibleStart + 200)}
                          >
                            下一页
                          </button>
                        </div>
                      ) : null}
                      {diff.hasMore ? (
                        <button
                          type="button"
                          className="ghost small"
                          onClick={async () => {
                            try {
                              const next = await window.deer.getReviewDiff({
                                taskId,
                                file: diff.file.path,
                                offset: diff.offset + diff.lines.length,
                                limit: 300,
                              });
                              setDiff({ ...next, lines: [...diff.lines, ...next.lines], offset: diff.offset });
                            } catch (err) {
                              fail(err);
                            }
                          }}
                        >
                          显示更多
                        </button>
                      ) : null}
                    </div>
                  )}
                </>
              ) : (
                <p className="muted small">{busy ? "加载 diff…" : "选择文件查看 diff"}</p>
              )}
            </div>
          </div>

          {composer ? (
            <div className="review-composer">
              <div className="row gap wrap">
                <strong>评论 {selectedFile}:{composer.line}</strong>
                <select
                  aria-label="评论严重程度"
                  value={commentSeverity}
                  onChange={(event) => setCommentSeverity(event.target.value as ReviewSeverity)}
                >
                  <option value="nit">小问题</option>
                  <option value="suggestion">建议</option>
                  <option value="issue">问题</option>
                  <option value="blocker">阻断</option>
                </select>
              </div>
              <textarea
                aria-label="评论内容"
                value={commentBody}
                maxLength={10000}
                rows={3}
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="说明问题、影响与建议修复"
              />
              <div className="row gap">
                <button type="button" className="primary small" disabled={busy || !commentBody.trim()} onClick={() => void submitComment()}>
                  发布评论
                </button>
                <button type="button" className="ghost small" onClick={() => setComposer(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          <div className="review-threads" aria-label="评论线程">
            {threads.length === 0 ? <p className="muted small">暂无评论。选择 diff 行添加评论。</p> : null}
            {threads.map((thread) => (
              <article key={thread.id} className={`review-thread ${thread.severity}`} aria-label={`${thread.filePath} 第 ${thread.lineStart} 行评论`}>
                <header className="row gap wrap">
                  <span className={`badge ${thread.severity === "blocker" ? "warn" : "muted"}`}>{severityLabel(thread.severity)}</span>
                  <span className="mono tiny">{threadLine(thread)}</span>
                  <span className="muted tiny">{thread.status}</span>
                </header>
                {thread.comments.map((comment: ReviewComment) =>
                  comment.deletedAt ? (
                    <p key={comment.id} className="muted tiny">评论已删除</p>
                  ) : (
                    <p key={comment.id} className="review-comment">
                      <span className="muted tiny">{comment.authorId}</span> {redact(comment.body)}
                    </p>
                  ),
                )}
                <div className="row gap wrap">
                  <button type="button" className="ghost tiny" onClick={() => setReplyTo(thread.id)}>
                    回复
                  </button>
                  <button type="button" className="ghost tiny" onClick={() => void resolve(thread)}>
                    {thread.status === "resolved" ? "重新打开" : "解决"}
                  </button>
                </div>
                {replyTo === thread.id ? (
                  <div className="row gap">
                    <input
                      aria-label="回复内容"
                      value={replyBody}
                      onChange={(event) => setReplyBody(event.target.value)}
                      placeholder="回复…"
                    />
                    <button type="button" className="primary tiny" disabled={busy} onClick={() => void reply(thread.id)}>
                      发送
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <footer className="review-decision">
            <div className="row gap wrap">
              <span className="tiny muted">
                {currentDecision ? `我的当前决定：${currentDecision.decision}（修订 ${currentDecision.revision}）` : "尚未提交决定"}
              </span>
              {!summary.gate.ok ? <span className="tiny warn">{summary.gate.reason}</span> : null}
            </div>
            <textarea
              aria-label="评审备注"
              value={decisionNotes}
              maxLength={10000}
              rows={2}
              onChange={(event) => setDecisionNotes(event.target.value)}
              placeholder="备注（要求修改时必填）"
            />
            <div className="row gap wrap">
              <button
                type="button"
                className="primary small"
                disabled={busy || !canDecide}
                aria-describedby={!canDecide ? "review-decision-hint" : undefined}
                onClick={() => void decide("approve")}
              >
                通过评审
              </button>
              <button
                type="button"
                className="ghost small run-danger"
                disabled={busy || summary.mode === "off"}
                onClick={() => void decide("request_changes")}
              >
                要求修改
              </button>
              {!canDecide ? (
                <span id="review-decision-hint" className="muted tiny">
                  存在 blocker、无评审人或评审已过期，不能通过
                </span>
              ) : null}
            </div>
          </footer>
        </>
      ) : null}
    </section>
  );
}
