import { useEffect, useMemo, useRef, useState } from "react";
import type { GitDiffFile, GitDiffPage } from "../readTypes.js";
import "./gitWorkingDiff.css";

type DiffLine = GitDiffFile["hunks"][number]["lines"][number];

type NumberedLine = DiffLine & { oldLine: number | null; newLine: number | null };

type HunkModel = {
  header: string;
  rows: NumberedLine[];
  insertions: number;
  deletions: number;
};

type SideRow = {
  kind: "+" | "-" | " ";
  oldLine: number | null;
  newLine: number | null;
  oldText: string | null;
  newText: string | null;
};

function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(header.trim());
  return { oldStart: match ? Number(match[1]) : 1, newStart: match ? Number(match[2]) : 1 };
}

/** t407：并排视图宽度阈值（<560 自动 unified）。 */
export function canUseSideBySide(width: number): boolean {
  return width >= 560;
}

/** t407：监听 diff pane 宽度；拆成纯函数便于 ResizeObserver 单测。 */
export function observeDiffWidth(
  node: Pick<HTMLElement, "getBoundingClientRect">,
  onChange: (wide: boolean) => void,
  ObserverCtor: typeof ResizeObserver | undefined = typeof ResizeObserver === "undefined"
    ? undefined
    : ResizeObserver,
): () => void {
  const update = () => onChange(canUseSideBySide(node.getBoundingClientRect().width));
  update();
  if (!ObserverCtor) return () => {};
  const observer = new ObserverCtor(update);
  observer.observe(node as HTMLElement);
  return () => observer.disconnect();
}

function numberHunk(file: GitDiffFile): HunkModel[] {
  return file.hunks.map((hunk) => {
    const { oldStart, newStart } = parseHunkHeader(hunk.header);
    let oldLine = oldStart;
    let newLine = newStart;
    let insertions = 0;
    let deletions = 0;
    const rows = hunk.lines.map((line): NumberedLine => {
      if (line.kind === "+") {
        insertions += 1;
        const row = { ...line, oldLine: null, newLine };
        newLine += 1;
        return row;
      }
      if (line.kind === "-") {
        deletions += 1;
        const row = { ...line, oldLine, newLine: null };
        oldLine += 1;
        return row;
      }
      const row = { ...line, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return row;
    });
    return { header: hunk.header, rows, insertions, deletions };
  });
}

export function buildSideBySide(rows: NumberedLine[]): SideRow[] {
  const result: SideRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind === " ") {
      result.push({
        kind: " ",
        oldLine: row.oldLine,
        newLine: row.newLine,
        oldText: row.text,
        newText: row.text,
      });
      index += 1;
      continue;
    }
    const deletes: NumberedLine[] = [];
    const adds: NumberedLine[] = [];
    while (index < rows.length && rows[index]!.kind === "-") {
      deletes.push(rows[index]!);
      index += 1;
    }
    while (index < rows.length && rows[index]!.kind === "+") {
      adds.push(rows[index]!);
      index += 1;
    }
    const count = Math.max(deletes.length, adds.length);
    for (let offset = 0; offset < count; offset += 1) {
      const deletion = deletes[offset];
      const addition = adds[offset];
      result.push({
        kind: deletion && addition ? " " : deletion ? "-" : "+",
        oldLine: deletion?.oldLine ?? null,
        newLine: addition?.newLine ?? null,
        oldText: deletion?.text ?? null,
        newText: addition?.text ?? null,
      });
    }
  }
  return result;
}

function HunkBlock({
  hunk,
  fileIndex,
  hunkIndex,
  totalLines,
  large,
}: {
  hunk: HunkModel;
  fileIndex: number;
  hunkIndex: number;
  totalLines: number;
  large: boolean;
}) {
  const [open, setOpen] = useState(!large);
  const [limit, setLimit] = useState(400);
  const [expandedContext, setExpandedContext] = useState(false);
  const shown = hunk.rows.slice(0, limit);
  const groups = useMemo(() => groupRows(shown, expandedContext), [shown, expandedContext]);

  return (
    <section className="git-diff-hunk" aria-label={hunk.header}>
      <button
        type="button"
        className="git-diff-hunk-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mono">{hunk.header}</span>
        <span className="git-diff-hunk-stats">
          {hunk.insertions > 0 ? <span className="diff-add">+{hunk.insertions}</span> : null}
          {hunk.deletions > 0 ? <span className="diff-del">−{hunk.deletions}</span> : null}
          {hunk.rows.length > 400 ? <span className="muted tiny">{hunk.rows.length} 行</span> : null}
        </span>
      </button>
      {open ? (
        <div className="git-diff-hunk-body">
          {groups.map((group, groupIndex) =>
            group.kind === "context-fold" ? (
              <button
                type="button"
                key={`fold-${fileIndex}-${hunkIndex}-${groupIndex}`}
                className="git-diff-fold"
                onClick={() => setExpandedContext(true)}
                aria-label={`展开 ${group.count} 行未变更内容`}
              >
                展开 {group.count} 行未变更内容
              </button>
            ) : group.kind === "context-restore" ? null : (
              <div
                key={`${fileIndex}-${hunkIndex}-${groupIndex}`}
                role="row"
                className={`git-diff-row diff-${group.row.kind === "+" ? "add" : group.row.kind === "-" ? "del" : "context"}`}
                tabIndex={0}
                aria-label={`旧行 ${group.row.oldLine ?? "无"}，新行 ${group.row.newLine ?? "无"}，${group.row.kind === "+" ? "新增" : group.row.kind === "-" ? "删除" : "上下文"}：${group.row.text}`}
              >
                <span className="git-diff-num" role="gridcell" aria-label={`旧行 ${group.row.oldLine ?? "无"}`}>
                  {group.row.oldLine ?? ""}
                </span>
                <span className="git-diff-num" role="gridcell" aria-label={`新行 ${group.row.newLine ?? "无"}`}>
                  {group.row.newLine ?? ""}
                </span>
                <span className="git-diff-sign" role="gridcell">{group.row.kind === " " ? " " : group.row.kind}</span>
                <span className="git-diff-text" role="gridcell">{group.row.text || " "}</span>
              </div>
            ),
          )}
          {hunk.rows.length > limit ? (
            <button
              type="button"
              className="ghost tiny git-diff-more"
              onClick={() => setLimit((value) => value + 400)}
            >
              继续加载 hunk（剩余 {hunk.rows.length - limit} 行）
            </button>
          ) : null}
          {large && totalLines > 500 && !open ? (
            <p className="muted tiny">大 diff 默认折叠 hunk，点击标题展开。</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SideHunkBlock({
  hunk,
  fileIndex,
  hunkIndex,
  large,
}: {
  hunk: HunkModel;
  fileIndex: number;
  hunkIndex: number;
  large: boolean;
}) {
  const [open, setOpen] = useState(!large);
  const [limit, setLimit] = useState(400);
  const rows = useMemo(() => buildSideBySide(hunk.rows), [hunk.rows]);
  const shown = rows.slice(0, limit);

  return (
    <section className="git-diff-hunk" aria-label={hunk.header}>
      <button
        type="button"
        className="git-diff-hunk-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mono">{hunk.header}</span>
        <span className="git-diff-hunk-stats">
          {hunk.insertions > 0 ? <span className="diff-add">+{hunk.insertions}</span> : null}
          {hunk.deletions > 0 ? <span className="diff-del">−{hunk.deletions}</span> : null}
          {rows.length > 400 ? <span className="muted tiny">{rows.length} 行</span> : null}
        </span>
      </button>
      {open ? (
        <div className="git-diff-hunk-body">
          {shown.map((row, index) => (
            <SideRowView
              key={`${fileIndex}-${hunkIndex}-side-${index}`}
              row={row}
              index={index}
            />
          ))}
          {rows.length > limit ? (
            <button
              type="button"
              className="ghost tiny git-diff-more"
              onClick={() => setLimit((value) => value + 400)}
            >
              继续加载并排行（剩余 {rows.length - limit} 行）
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function groupRows(
  rows: NumberedLine[],
  expandedContext: boolean,
): Array<
  | { kind: "row"; row: NumberedLine }
  | { kind: "context-fold"; count: number }
  | { kind: "context-restore" }
> {
  const groups: Array<
    | { kind: "row"; row: NumberedLine }
    | { kind: "context-fold"; count: number }
    | { kind: "context-restore" }
  > = [];
  let index = 0;
  while (index < rows.length) {
    const context: NumberedLine[] = [];
    let scan = index;
    while (scan < rows.length && rows[scan]!.kind === " ") {
      context.push(rows[scan]!);
      scan += 1;
    }
    if (context.length > 6 && !expandedContext) {
      context.slice(0, 2).forEach((row) => groups.push({ kind: "row", row }));
      groups.push({ kind: "context-fold", count: context.length - 4 });
      groups.push({ kind: "row", row: context[context.length - 2]! });
      groups.push({ kind: "row", row: context[context.length - 1]! });
      index = scan;
      continue;
    }
    context.forEach((row) => groups.push({ kind: "row", row }));
    if (scan === index) {
      groups.push({ kind: "row", row: rows[index]! });
      index += 1;
    } else {
      index = scan;
    }
  }
  return groups;
}

function SideRowView({ row, index }: { row: SideRow; index: number }) {
  const leftClass = row.oldText === null ? "diff-empty" : row.kind === "-" || row.oldText !== row.newText ? "diff-del" : "diff-context";
  const rightClass = row.newText === null ? "diff-empty" : row.kind === "+" || row.oldText !== row.newText ? "diff-add" : "diff-context";
  return (
    <div
      className="git-diff-side-row"
      role="row"
      tabIndex={0}
      aria-label={`旧行 ${row.oldLine ?? "无"}，新行 ${row.newLine ?? "无"}，${row.kind === "+" ? "新增" : row.kind === "-" ? "删除" : "修改"}`}
      data-row={index}
    >
      <span className="git-diff-num" role="gridcell" aria-label={`旧行 ${row.oldLine ?? "无"}`}>
        {row.oldLine ?? ""}
      </span>
      <span
        className={`git-diff-text ${leftClass}`}
        role="gridcell"
        aria-label={`旧文本 ${row.oldText ?? "无"}`}
      >
        {row.oldText ?? ""}
      </span>
      <span className="git-diff-num" role="gridcell" aria-label={`新行 ${row.newLine ?? "无"}`}>
        {row.newLine ?? ""}
      </span>
      <span
        className={`git-diff-text ${rightClass}`}
        role="gridcell"
        aria-label={`新文本 ${row.newText ?? "无"}`}
      >
        {row.newText ?? ""}
      </span>
    </div>
  );
}

export function GitDiffViewer({
  diff,
  loading = false,
  error = null,
  availableWidth,
}: {
  diff: GitDiffPage | null;
  loading?: boolean;
  error?: string | null;
  /** 测试/嵌入场景可显式给出 diff pane 宽度；生产环境使用 ResizeObserver。 */
  availableWidth?: number;
}) {
  const [mode, setMode] = useState<"unified" | "side">("unified");
  const [wrap, setWrap] = useState(false);
  const [wide, setWide] = useState(
    availableWidth == null ? false : canUseSideBySide(availableWidth),
  );
  const [copied, setCopied] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (availableWidth != null) {
      setWide(canUseSideBySide(availableWidth));
      return;
    }
    const node = ref.current;
    if (!node) return;
    return observeDiffWidth(node, setWide);
  }, [availableWidth]);

  useEffect(() => {
    if (!wide) setMode("unified");
  }, [wide]);

  function onDiffKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("git-diff-row") && !target.classList.contains("git-diff-side-row")) {
      return;
    }
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".git-diff-row, .git-diff-side-row")];
    const index = rows.indexOf(target);
    if (index < 0) return;
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  if (loading) {
    return (
      <div className="git-diff-viewer" ref={ref} aria-busy="true">
        <p className="muted small" role="status">加载 diff…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="git-diff-viewer" ref={ref}>
        <p className="git-diff-state is-error" role="alert">{error}</p>
      </div>
    );
  }
  if (!diff) {
    return (
      <div className="git-diff-viewer" ref={ref}>
        <p className="muted small git-st-empty">选择文件或提交查看 diff。</p>
      </div>
    );
  }
  if (diff.binary) {
    return (
      <div className="git-diff-viewer" ref={ref}>
        <p className="git-diff-state" role="status">二进制文件不显示 diff。</p>
      </div>
    );
  }
  if (diff.submodule) {
    return (
      <div className="git-diff-viewer" ref={ref}>
        <p className="git-diff-state" role="status">子模块变更不展开。</p>
      </div>
    );
  }
  if (diff.files.length === 0) {
    return (
      <div className="git-diff-viewer" ref={ref}>
        <p className="muted small git-st-empty">没有文本 diff（空文件或仅模式变化）。</p>
      </div>
    );
  }

  const totalLines = diff.files.reduce(
    (sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
    0,
  );
  const large = totalLines > 1200 || diff.bytes > 512 * 1024;

  return (
    <div className="git-diff-viewer" ref={ref} onKeyDown={onDiffKeyDown}>
      <div className="git-diff-toolbar">
        <span className="muted tiny">
          {diff.files.length} 文件 · {totalLines} 行{diff.bytes ? ` · ${Math.round(diff.bytes / 1024)}KB` : ""}
        </span>
        <div className="row gap">
          <button
            type="button"
            className="ghost tiny"
            aria-pressed={mode === "unified"}
            onClick={() => setMode("unified")}
          >
            统一
          </button>
          <button
            type="button"
            className="ghost tiny"
            aria-pressed={mode === "side"}
            disabled={!wide}
            title={!wide ? "窄窗自动使用统一视图" : "并排视图"}
            onClick={() => setMode("side")}
          >
            并排
          </button>
          <button
            type="button"
            className="ghost tiny"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            换行
          </button>
          <input
            type="search"
            className="git-diff-search"
            placeholder="搜索 diff（即将支持）"
            aria-label="搜索 diff（即将支持）"
            disabled
            title="D1 扩展点：diff 搜索"
          />
        </div>
      </div>
      {diff.truncated ? (
        <p className="git-diff-state is-warn" role="status">
          diff 已截断{diff.reason === "max-bytes" ? "（超过大小上限）" : ""}，仅展示可用部分。
        </p>
      ) : null}
      {large ? (
        <p className="muted tiny" role="status">大 diff：hunk 默认折叠，按 400 行分块渲染。</p>
      ) : null}
      {diff.files.map((file, fileIndex) => {
        const hunks = numberHunk(file);
        const insertions = hunks.reduce((sum, hunk) => sum + hunk.insertions, 0);
        const deletions = hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
        return (
          <section className="git-diff-file" key={`${file.path}-${fileIndex}`} aria-label={`diff ${file.path}`}>
            <header className="git-diff-file-head">
              <span className="badge" title="文件状态">{file.status}</span>
              <span className="mono ellipsis" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
              <span className="diff-add">+{insertions}</span>
              <span className="diff-del">−{deletions}</span>
              <button
                type="button"
                className="ghost tiny"
                onClick={() => {
                  void navigator.clipboard?.writeText(file.path);
                  setCopied(file.path);
                }}
                aria-label={`复制路径 ${file.path}`}
              >
                {copied === file.path ? "已复制" : "复制路径"}
              </button>
            </header>
            {file.binary ? (
              <p className="git-diff-state">二进制文件不显示 diff。</p>
            ) : file.submodule ? (
              <p className="git-diff-state">子模块变更不展开。</p>
            ) : file.truncated ? (
              <p className="git-diff-state is-warn">该文件 diff 已截断。</p>
            ) : file.hunks.length === 0 ? (
              <p className="git-diff-state">该文件没有文本改动。</p>
            ) : mode === "side" && wide ? (
              <div className="git-diff-side" role="table" aria-label={`${file.path} 并排 diff`}>
                {hunks.map((hunk, hunkIndex) => (
                  <SideHunkBlock
                    key={`${file.path}-side-${hunkIndex}`}
                    hunk={hunk}
                    fileIndex={fileIndex}
                    hunkIndex={hunkIndex}
                    large={large}
                  />
                ))}
              </div>
            ) : (
              <div
                className={`git-diff-unified ${wrap ? "is-wrapped" : ""}`}
                role="table"
                aria-label={`${file.path} 统一 diff`}
              >
                {hunks.map((hunk, hunkIndex) => (
                  <HunkBlock
                    key={`${file.path}-${hunkIndex}`}
                    hunk={hunk}
                    fileIndex={fileIndex}
                    hunkIndex={hunkIndex}
                    totalLines={totalLines}
                    large={large}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
