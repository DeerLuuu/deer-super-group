/**
 * C24 空状态统一组件：图标 + 标题 + 说明 + 主/次 CTA。
 * 全应用的空态都应使用这里，禁止再写「点右上角」式的纯文本提示。
 */

export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  primary?: boolean;
};

export default function EmptyState({
  icon = "◌",
  title,
  description,
  actions,
  compact = false,
}: {
  icon?: string;
  title: string;
  description?: string;
  actions?: EmptyStateAction[];
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc muted">{description}</div>}
      {actions && actions.length > 0 && (
        <div className="empty-state-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.primary ? "primary small" : "ghost small"}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
