import { useEffect, useMemo, useState } from "react";
import {
  QUESTION_KIND_LABEL,
  questionAnswerLines,
  type DeerQuestion,
} from "../shared/interactive";
import type { ChatQuestionRecord } from "../shared/types";

/**
 * t64：对话内问题卡片（设计 §6.2）。
 * - 始终显示在对话气泡里，是「稍后回答」后再次进入的入口；
 * - 状态来自服务端 listChatQuestions；缺失记录时明确 E_NOT_PERSISTED（不无限 loading）；
 * - 已回答显示前 3 项摘要 + 可展开全部；终态不再显示提交入口。
 */
export default function QuestionCard({
  questionId,
  question,
  record,
  questionsLoaded,
  onOpen,
}: {
  questionId: string;
  question: DeerQuestion;
  record?: ChatQuestionRecord;
  questionsLoaded?: boolean;
  onOpen?: (questionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const fieldCount = question.fields.length;

  useEffect(() => {
    if (!record || record.status !== "pending" || !record.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [record]);

  const expiredByClock = useMemo(() => {
    if (!record?.expiresAt) return false;
    const deadline = Date.parse(record.expiresAt);
    return Number.isFinite(deadline) && deadline <= now;
  }, [now, record?.expiresAt]);

  const status = record?.status ?? null;
  const answeredLines = useMemo(
    () => (record?.answer ? questionAnswerLines(question, record.answer.values) : []),
    [question, record],
  );

  return (
    <section
      className={`question-card${status ? ` is-${status}` : ""}`}
      aria-label={`需要你确认的问题：${question.title}`}
      data-question-id={questionId}
    >
      <div className="question-card-head">
        <span className="question-card-icon" aria-hidden="true">
          ◇
        </span>
        <div className="question-card-heading">
          <div className="question-card-title">{question.title}</div>
          <div className="muted tiny">
            {fieldCount} 个字段 ·{" "}
            {status === "answered"
              ? "已回答"
              : status === "expired"
                ? "已过期 · 未提交"
                : status === "cancelled"
                  ? "已取消"
                  : record
                    ? expiredByClock
                      ? "已过期 · 未提交"
                      : "待回答"
                    : "问题状态加载中…"}
          </div>
        </div>
        {status === "pending" && record?.expiresAt && (
          <span className="question-timeout muted tiny" aria-hidden="true">
            剩余 {formatRemaining(record.expiresAt, now)}
          </span>
        )}
      </div>

      {question.description && <p className="question-card-desc muted">{question.description}</p>}

      {!record && !questionsLoaded && (
        <div className="question-card-actions">
          <span className="muted tiny">问题状态加载中…</span>
          <button type="button" className="ghost small" disabled>
            回答问题
          </button>
        </div>
      )}
      {!record && questionsLoaded && (
        <div className="question-card-actions">
          <span className="muted tiny">E_NOT_PERSISTED：服务端未记录该问题，暂时无法回答</span>
        </div>
      )}

      {record?.status === "pending" && (
        <div className="question-card-actions">
          <span className="muted tiny">
            {expiredByClock ? "已过期，提交会被服务端拒绝" : "回答后会作为一条新消息发送给 Router"}
          </span>
          <button
            type="button"
            className="primary small"
            disabled={expiredByClock}
            onClick={() => onOpen?.(questionId)}
          >
            回答问题
          </button>
        </div>
      )}

      {record?.status === "answered" && (
        <div className="question-card-answers">
          <div className="question-card-answer-list">
            {answeredLines.slice(0, expanded ? answeredLines.length : 3).map((line) => (
              <div key={line.label} className="question-card-answer">
                <span className="muted tiny">{line.label}</span>
                <span>{line.value}</span>
              </div>
            ))}
          </div>
          {answeredLines.length > 3 && (
            <button
              type="button"
              className="ghost tiny"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起回答" : `展开全部（${answeredLines.length}）`}
            </button>
          )}
        </div>
      )}

      {record?.status === "expired" && (
        <div className="muted tiny">该问题在有效期内未提交。可以继续对话，让 Router 重新提问。</div>
      )}
      {record?.status === "cancelled" && (
        <div className="muted tiny">该问题已取消，不会再要求回答。</div>
      )}

      <details className="question-card-fields">
        <summary className="muted tiny">查看字段</summary>
        <ul>
          {question.fields.map((field) => (
            <li key={field.id}>
              <span>{field.label}</span>
              <span className="muted tiny">
                {QUESTION_KIND_LABEL[field.kind]}
                {field.required ? " · 必填" : " · 选填"}
                {field.kind === "single" || field.kind === "multi"
                  ? ` · ${field.options.length} 个选项`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** 剩余时间：mm:ss；过期显示「已过期」。 */
export function formatRemaining(expiresAt: string, now: number): string {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return "—";
  const remaining = Math.max(0, deadline - now);
  if (remaining <= 0) return "已过期";
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
