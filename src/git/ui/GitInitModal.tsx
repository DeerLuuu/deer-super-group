import { useRef } from "react";
import Modal from "../../Modal.js";

export interface GitInitModalProps {
  workspacePath: string;
  root: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function GitInitModal({ workspacePath, root, busy, error, onCancel, onConfirm }: GitInitModalProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Modal
      title="初始化 Git 仓库"
      description="此操作会在工作区根目录创建 .git，不会修改现有文件。"
      onClose={() => {
        if (!busy) onCancel();
      }}
      initialFocusRef={cancelRef}
      className="git-init-modal"
    >
      <dl className="git-init-summary">
        <dt>工作区</dt>
        <dd className="mono ellipsis" title={workspacePath}>{workspacePath}</dd>
        <dt>将创建</dt>
        <dd className="mono">{root}/.git</dd>
        <dt>默认分支</dt>
        <dd><code>main</code>（尚无提交）</dd>
      </dl>
      <p className="muted small">
        不会修改现有文件、不会执行 git add、不会提交、不会生成 .gitignore，也不会创建 remote、PR 或 worktree。
      </p>
      {error ? <p className="git-init-error" role="alert">{error}</p> : null}
      <div className="git-init-actions">
        <button ref={cancelRef} type="button" className="ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? "初始化中…" : error ? "重试初始化" : "初始化 Git 仓库"}
        </button>
      </div>
    </Modal>
  );
}
