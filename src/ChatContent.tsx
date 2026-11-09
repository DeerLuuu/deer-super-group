import { Fragment } from "react";
import type { ChatQuestionRecord, ChatRole } from "./shared/types";
import {
  parseChatContent,
  stripInteractiveForStreaming,
} from "./shared/interactive";
import Markdown from "./Markdown";
import CanvasCard from "./canvas/CanvasCard";
import CanvasFallback from "./canvas/CanvasFallback";
import QuestionCard from "./interactive/QuestionCard";
import QuestionFallback from "./interactive/QuestionFallback";
import type { CanvasToastInput } from "./canvas/CanvasCard";

/**
 * t64：助手消息内容切分（设计 §3.2 / §7.1 / §7.2）。
 *
 * - 文本段继续复用现有 <Markdown>（skipHtml 不变）；
 * - deer-canvas → CanvasCard，deer-question → QuestionCard；
 * - 失败块 → 回退卡片（不渲染半张图/不可答表单）；
 * - 用户/系统消息永远纯文本（不解析 deer-*，防伪造）；
 * - 流式阶段剥离未完成 fence，不裸露 JSON。
 */
export default function ChatContent({
  role,
  content,
  messageId,
  streaming,
  questions,
  questionsLoaded,
  onAnswerQuestion,
  onToast,
}: {
  role: ChatRole;
  content: string;
  messageId?: string;
  streaming?: boolean;
  /** 按 chatBlockKey 索引的问题状态（来自 listChatQuestions）。 */
  questions?: ReadonlyMap<string, ChatQuestionRecord>;
  /** false = 状态尚未加载；true = 已加载（缺失记录按 E_NOT_PERSISTED 回退）。 */
  questionsLoaded?: boolean;
  onAnswerQuestion?: (questionId: string) => void;
  onToast?: (toast: CanvasToastInput) => void;
}) {
  if (role !== "assistant") {
    return <div className="chat-plain">{content}</div>;
  }

  if (streaming) {
    const preview = stripInteractiveForStreaming(content);
    return (
      <div className="chat-content-blocks">
        {preview.text.trim() && <Markdown content={preview.text} />}
        {preview.pending && (
          <div className="interactive-pending muted tiny" role="status" aria-live="polite">
            {preview.pending === "canvas" ? "正在生成画布…" : "正在生成表单…"}
          </div>
        )}
      </div>
    );
  }

  const blocks = parseChatContent(content, {
    role: "assistant",
    messageId,
    complete: true,
  });

  return (
    <div className="chat-content-blocks">
      {blocks.map((block, index) => {
        if (block.type === "text") {
          if (!block.text.trim()) return null;
          return (
            <Fragment key={`text-${index}`}>
              <Markdown content={block.text} />
            </Fragment>
          );
        }
        if (block.type === "canvas") {
          return (
            <CanvasCard
              key={block.key}
              artifactKey={block.key}
              artifact={block.artifact}
              raw={block.raw}
              warnings={block.warnings}
              onToast={onToast}
            />
          );
        }
        if (block.type === "canvas_error") {
          return <CanvasFallback key={block.key} raw={block.raw} error={block.error} />;
        }
        if (block.type === "question") {
          return (
            <QuestionCard
              key={block.key}
              questionId={block.key}
              question={block.question}
              record={questions?.get(block.key)}
              questionsLoaded={questionsLoaded}
              onOpen={onAnswerQuestion}
            />
          );
        }
        return <QuestionFallback key={block.key} raw={block.raw} error={block.error} />;
      })}
    </div>
  );
}
