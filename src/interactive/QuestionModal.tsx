import { useEffect, useId, useMemo, useRef, useState } from "react";
import Modal from "../Modal";
import {
  QUESTION_KIND_LABEL,
  validateQuestionAnswers,
  type DeerQuestion,
  type QuestionField,
  type QuestionFieldError,
  type QuestionValues,
} from "../shared/interactive";
import type { ChatQuestionRecord } from "../shared/types";
import { formatRemaining } from "./QuestionCard";

export type QuestionSubmitResult =
  | { ok: true }
  | { ok: false; fieldErrors?: QuestionFieldError[]; message?: string };

/**
 * t64：原生表单提问弹窗（设计 §6.2/§6.7/§6.9）。
 * - 一个 deer-question = 一张 1–6 字段的表单（单/多选/文本/确认）；
 * - 复用 Modal：Esc/焦点陷阱/回焦/aria-modal/滚动锁，新增 initialFocusRef 聚焦首个字段；
 * - 客户端校验只是体验层；服务端会重新校验（AC-28）；
 * - 取消提问需二次确认（4s 内再点才生效）；稍后回答不销毁草稿。
 */
export default function QuestionModal({
  question,
  index,
  total,
  busy,
  initialValues,
  onDraftChange,
  onSubmit,
  onDefer,
  onCancel,
  onExpire,
}: {
  question: ChatQuestionRecord;
  index: number;
  total: number;
  busy: boolean;
  initialValues?: QuestionValues;
  onDraftChange?: (values: QuestionValues) => void;
  onSubmit: (values: QuestionValues) => Promise<QuestionSubmitResult>;
  onDefer: () => void;
  onCancel: () => Promise<void>;
  onExpire?: () => void;
}) {
  const formId = useId().replace(/[:]/g, "");
  const definition: DeerQuestion = question.payload;
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const fieldRefs = useRef(new Map<string, HTMLElement | null>());
  const cancelTimerRef = useRef<number | null>(null);
  const expiredRef = useRef(false);
  const [values, setValues] = useState<QuestionValues>(() =>
    initialValues ?? defaultValues(definition),
  );
  const [errors, setErrors] = useState<QuestionFieldError[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const expiresAt = question.expiresAt;
  const expired = useMemo(() => {
    if (!expiresAt) return false;
    const deadline = Date.parse(expiresAt);
    return Number.isFinite(deadline) && deadline <= now;
  }, [expiresAt, now]);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!expired || expiredRef.current) return;
    expiredRef.current = true;
    onExpire?.();
  }, [expired, onExpire]);

  useEffect(() => {
    return () => {
      if (cancelTimerRef.current !== null) window.clearTimeout(cancelTimerRef.current);
    };
  }, []);

  const errorsByField = useMemo(() => {
    const map = new Map<string, QuestionFieldError>();
    for (const error of errors) {
      if (!map.has(error.fieldId)) map.set(error.fieldId, error);
    }
    return map;
  }, [errors]);

  function updateValue(fieldId: string, value: string | string[] | boolean | undefined) {
    setValues((current) => {
      const next: QuestionValues = { ...current };
      if (value === undefined) delete next[fieldId];
      else next[fieldId] = value;
      onDraftChange?.(next);
      return next;
    });
    setErrors((current) => current.filter((error) => error.fieldId !== fieldId));
    setMessage("");
  }

  function focusField(fieldId: string) {
    const element = fieldRefs.current.get(fieldId);
    element?.focus();
  }

  function describeError(fieldId: string): string | undefined {
    const error = errorsByField.get(fieldId);
    if (!error) return undefined;
    return `${formId}-${fieldId}-error`;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || busy) return;
    if (expired) {
      setMessage("该问题已过期，未提交");
      return;
    }
    const validated = validateQuestionAnswers(definition, values);
    if (!validated.ok) {
      setErrors(validated.errors);
      setMessage("请修正以下字段后再提交");
      const first = validated.errors[0];
      if (first) focusField(first.fieldId);
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const result = await onSubmit(validated.values);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? []);
        setMessage(result.message ?? "提交失败，请稍后再试");
        const first = result.fieldErrors?.[0];
        if (first) focusField(first.fieldId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (cancelArmed) {
      if (cancelTimerRef.current !== null) window.clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = null;
      setCancelArmed(false);
      setSubmitting(true);
      try {
        await onCancel();
      } finally {
        setSubmitting(false);
      }
      return;
    }
    setCancelArmed(true);
    cancelTimerRef.current = window.setTimeout(() => {
      cancelTimerRef.current = null;
      setCancelArmed(false);
    }, 4000);
  }

  const disabled = busy || submitting;
  const queueLabel = `问题 ${index + 1}/${total}`;
  const timeoutLabel = expiresAt
    ? expandedTimeLabel(expiresAt)
    : null;

  return (
    <Modal
      title={`问题：${definition.title}`}
      description={`${queueLabel}${timeoutLabel ? ` · ${timeoutLabel}` : " · 可稍后回答"}`}
      onClose={onDefer}
      initialFocusRef={initialFocusRef}
      className="question-modal"
    >
      <form className="question-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        {definition.description && (
          <p className="question-description muted">{definition.description}</p>
        )}

        <div className="question-fields">
          {definition.fields.map((field, fieldIndex) => {
            const error = errorsByField.get(field.id);
            const controlId = `${formId}-${field.id}`;
            const describedBy = describeError(field.id);
            return (
              <fieldset
                key={field.id}
                className={`question-field${error ? " has-error" : ""}${field.kind === "confirm" && field.danger ? " danger" : ""}`}
                aria-describedby={describedBy}
              >
                <legend>
                  {field.label}
                  {field.required ? (
                    <span className="question-required" aria-label="必填">
                      {" "}
                      *
                    </span>
                  ) : (
                    <span className="muted tiny">（选填）</span>
                  )}
                  <span className="question-kind muted tiny">{QUESTION_KIND_LABEL[field.kind]}</span>
                </legend>
                {field.description && (
                  <div className="question-field-desc muted tiny">{field.description}</div>
                )}
                {field.kind === "single" && (
                  <div className="question-options" role="radiogroup" aria-labelledby={controlId}>
                    {field.options.map((option, optionIndex) => (
                      <label key={option.id} className="question-option">
                        <input
                          type="radio"
                          name={`${formId}-${field.id}`}
                          value={option.id}
                          checked={values[field.id] === option.id}
                          disabled={disabled}
                          ref={(element) => {
                            if (fieldIndex === 0 && optionIndex === 0) {
                              initialFocusRef.current = element;
                            }
                            if (!fieldRefs.current.has(field.id)) {
                              fieldRefs.current.set(field.id, element);
                            }
                          }}
                          onChange={() => updateValue(field.id, option.id)}
                        />
                        <span>
                          {option.label}
                          {option.description && (
                            <span className="question-option-desc muted tiny">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {field.kind === "multi" && (
                  <div className="question-multi" role="group" aria-labelledby={controlId}>
                    <div className="question-count muted tiny">
                      已选{" "}
                      {Array.isArray(values[field.id]) ? (values[field.id] as string[]).length : 0}/
                      {field.max ?? field.options.length}
                      {field.min ? ` · 至少 ${field.min} 项` : ""}
                    </div>
                    <div className="question-options">
                      {field.options.map((option, optionIndex) => {
                        const selected = Array.isArray(values[field.id])
                          ? (values[field.id] as string[])
                          : [];
                        return (
                          <label key={option.id} className="question-option">
                            <input
                              type="checkbox"
                              value={option.id}
                              checked={selected.includes(option.id)}
                              disabled={disabled}
                              ref={(element) => {
                                if (fieldIndex === 0 && optionIndex === 0) {
                                  initialFocusRef.current = element;
                                }
                                if (!fieldRefs.current.has(field.id)) {
                                  fieldRefs.current.set(field.id, element);
                                }
                              }}
                              onChange={(event) => {
                                const next = event.target.checked
                                  ? [...selected, option.id]
                                  : selected.filter((id) => id !== option.id);
                                updateValue(field.id, next);
                              }}
                            />
                            <span>
                              {option.label}
                              {option.description && (
                                <span className="question-option-desc muted tiny">
                                  {option.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                {field.kind === "text" && (
                  <div className="question-text">
                    {field.multiline ? (
                      <textarea
                        id={controlId}
                        ref={(element) => {
                          if (fieldIndex === 0) initialFocusRef.current = element;
                          fieldRefs.current.set(field.id, element);
                        }}
                        value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                        maxLength={field.maxLength}
                        rows={4}
                        placeholder={field.placeholder}
                        disabled={disabled}
                        aria-invalid={Boolean(error)}
                        onChange={(event) => updateValue(field.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                      />
                    ) : (
                      <input
                        id={controlId}
                        ref={(element) => {
                          if (fieldIndex === 0) initialFocusRef.current = element;
                          fieldRefs.current.set(field.id, element);
                        }}
                        value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                        maxLength={field.maxLength}
                        placeholder={field.placeholder}
                        disabled={disabled}
                        aria-invalid={Boolean(error)}
                        onChange={(event) => updateValue(field.id, event.target.value)}
                      />
                    )}
                    <div className="question-count muted tiny">
                      {typeof values[field.id] === "string" ? (values[field.id] as string).length : 0}/
                      {field.maxLength}
                    </div>
                  </div>
                )}
                {field.kind === "confirm" && (
                  <div className="question-options question-confirm" role="radiogroup">
                    <label className="question-option">
                      <input
                        type="radio"
                        name={`${formId}-${field.id}`}
                        checked={values[field.id] === true}
                        disabled={disabled}
                        ref={(element) => {
                          if (fieldIndex === 0) initialFocusRef.current = element;
                          if (!fieldRefs.current.has(field.id)) {
                            fieldRefs.current.set(field.id, element);
                          }
                        }}
                        onChange={() => updateValue(field.id, true)}
                      />
                      <span>{field.danger ? "确认（危险操作）" : "确认"}</span>
                    </label>
                    <label className="question-option">
                      <input
                        type="radio"
                        name={`${formId}-${field.id}`}
                        checked={values[field.id] === false}
                        disabled={disabled}
                        onChange={() => updateValue(field.id, false)}
                      />
                      <span>不确认</span>
                    </label>
                  </div>
                )}
                {error && (
                  <div className="question-error" id={`${formId}-${field.id}-error`}>
                    {error.message}
                  </div>
                )}
              </fieldset>
            );
          })}
        </div>

        {message && (
          <div className="question-error-summary" role="alert">
            {message}
          </div>
        )}
        {busy && <div className="muted tiny">Router 正在回复，完成后才能提交回答。</div>}
        {expired && <div className="question-error-summary" role="alert">该问题已到期，未提交。</div>}

        <div className="question-privacy muted tiny">
          回答会作为一条消息发送给当前配置的模型；请勿在回答中填写密码、密钥或令牌。
        </div>

        <div className="modal-foot question-foot">
          <button type="button" className="ghost" onClick={onDefer} disabled={submitting}>
            稍后回答
          </button>
          <button
            type="button"
            className={`ghost ${cancelArmed ? "danger" : ""}`}
            onClick={() => void handleCancel()}
            disabled={submitting}
            title="取消后该问题不再要求回答（需二次确认）"
          >
            {cancelArmed ? "确认取消？" : "取消提问"}
          </button>
          <span className="question-timeout muted tiny" aria-hidden="true">
            {expiresAt ? `剩余 ${formatRemaining(expiresAt, now)}` : ""}
          </span>
          <button
            type="submit"
            className="primary"
            disabled={disabled || expired}
            aria-busy={submitting}
          >
            {submitting ? "提交中…" : "提交回答"}
          </button>
        </div>
        <div className="sr-only">
          {queueLabel}
          {expiresAt ? `，${expandedTimeLabel(expiresAt, true)}` : "，可稍后回答"}
        </div>
      </form>
    </Modal>
  );
}

function defaultValues(question: DeerQuestion): QuestionValues {
  const values: QuestionValues = {};
  for (const field of question.fields) {
    if (field.kind === "multi") values[field.id] = [];
    else if (field.kind === "text") values[field.id] = "";
  }
  return values;
}

function expandedTimeLabel(expiresAt: string, staticText = false): string {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return "该问题在有效期内可回答";
  if (staticText) {
    const time = new Date(deadline).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    return `该问题在 ${time} 前有效`;
  }
  const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `剩余 ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 供组件测试/文档引用：字段类型中文（避免第二份映射）。 */
export const QUESTION_FIELD_KIND_LABEL = QUESTION_KIND_LABEL;
export type { QuestionField };
