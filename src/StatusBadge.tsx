import { statusLabel } from "./shared/copy";

/**
 * C01 统一状态徽章：任务与成员共用，文案来自 shared/copy，
 * 颜色来自 styles.css 的 --status-* 语义 token（status-<status> 类）。
 */
export default function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{statusLabel(status)}</span>;
}
