export default function ApprovalTerms() {
  return (
    <div className="muted tiny" role="note" aria-label="批准术语说明">
      任务交付批准 / 代码评审通过 / 合并确认是三个不同 gate；任务交付批准不等于代码评审通过，未通过 review 不能 merge。
    </div>
  );
}
