export default function SeparatorControl({
  label,
  value,
  min,
  max,
  onStep,
  onReset,
  onMouseDown,
  onDoubleClick,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onStep: (delta: number) => void;
  onReset: () => void;
  onMouseDown?: (event: { preventDefault: () => void }) => void;
  onDoubleClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={className}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, Math.max(min, value))}
      tabIndex={0}
      title="方向键调整；Home 恢复默认；也可拖动或双击"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onStep(event.key === "ArrowLeft" ? -16 : 16);
        } else if (event.key === "Home") {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
