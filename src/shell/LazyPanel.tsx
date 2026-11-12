import {
  Component,
  Suspense,
  lazy,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

export type LazyPanelLoader<P extends object> = () => Promise<{ default: ComponentType<P> }>;

class LazyPanelBoundary extends Component<
  { label: string; onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // 错误细节不写入 UI，避免路径/凭据泄漏；用户可重试。
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section className="lazy-panel-error" role="alert" aria-label={`${this.props.label}加载失败`}>
          <div className="panel-title">{this.props.label}加载失败</div>
          <p className="muted small">面板资源未能加载，其他面板不受影响。</p>
          <button
            type="button"
            className="primary small"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onRetry();
            }}
          >
            重试
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

/**
 * t323：重面板 lazy boundary。
 * - Suspense fallback 占满可用高度，避免 Dock 面板跳动；
 * - lazy rejection 由 boundary 接住，按钮重试会重新创建 lazy 组件（而不是复用已拒绝的缓存）。
 * - children 以“已加载组件”为参数，保持原有 props/callback 原样，不做数据语义改造。
 */
export function LazyPanel<P extends object>({
  load,
  label,
  children,
}: {
  load: LazyPanelLoader<P>;
  label: string;
  children: (Component: ComponentType<P>) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const Component = useMemo(() => lazy(load), [load, attempt]);
  return (
    <LazyPanelBoundary
      label={label}
      onRetry={() => setAttempt((value) => value + 1)}
    >
      <Suspense
        fallback={
          <section className="lazy-panel-fallback" role="status" aria-live="polite" aria-busy="true">
            <div className="panel-title">{label}</div>
            <div className="lazy-panel-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="muted tiny">正在加载面板…</div>
          </section>
        }
      >
        {children(Component)}
      </Suspense>
    </LazyPanelBoundary>
  );
}
