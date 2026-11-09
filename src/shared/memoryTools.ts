import type { ToolDefinition, ToolContext } from "../kernel/tools.js";
import type { MemoryRuntime } from "./memoryRuntime.js";
import type { BoardKind } from "./types.js";
import type { MemoryScope, MemoKind } from "../memory/types.js";

function parseScopes(value: unknown): MemoryScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed: MemoryScope[] = ["board", "memo", "summary"];
  return value.filter((item): item is MemoryScope => typeof item === "string" && allowed.includes(item as MemoryScope));
}

/**
 * Agent-facing memory tools. Human governance (pin/verify/archive/promote) is
 * intentionally absent; the existing board/memo tools remain for compatibility.
 */
export function createMemoryTools(memory: MemoryRuntime): ToolDefinition[] {
  const search: ToolDefinition = {
    name: "memory.search",
    description: "Search shared board, own memos and past task summaries. Returns citations and score breakdown.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        scopes: { type: "array", items: { type: "string", enum: ["board", "memo", "summary"] } },
        board: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const input = args as { query?: unknown; scopes?: unknown; board?: unknown; limit?: unknown };
      const query = String(input.query ?? "").trim();
      if (!query) throw new Error("memory.search query is required");
      const result = memory.searchForAgent({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        query,
        scopes: parseScopes(input.scopes),
        board: typeof input.board === "string" ? input.board : undefined,
        limit: Math.min(20, Math.max(1, Number(input.limit) || 8)),
      });
      return {
        total: result.total,
        budget: result.budget,
        hits: result.hits.slice(0, 8).map((hit) => ({
          id: hit.id,
          entityType: hit.entityType,
          title: hit.title,
          snippet: hit.snippet,
          citations: hit.citations,
          score: hit.score,
          stale: hit.stale,
          confidence: hit.confidence,
        })),
      };
    },
  };

  const context: ToolDefinition = {
    name: "memory.context",
    description: "Build the current task's memory context (working/episodic/semantic) with citations.",
    parameters: { type: "object", properties: { maxTokens: { type: "number" } } },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const maxTokens = Math.min(4000, Math.max(100, Number((args as { maxTokens?: unknown })?.maxTokens) || 1200));
      const built = memory.buildContext({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        maxTokens,
      });
      return {
        text: built.text,
        citations: built.sections.flatMap((section) => section.citations),
        usedTokens: built.usedTokens,
        maxTokens: built.maxTokens,
        truncated: built.truncated,
        omitted: built.omitted,
      };
    },
  };

  const addMemo: ToolDefinition = {
    name: "memory.memo.write",
    description: "Write a private memo for the current agent (lesson, failure, shortcut, preference).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lesson", "failure", "shortcut", "preference"] },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        expiresInDays: { type: "number" },
      },
      required: ["kind", "content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const input = args as {
        kind?: unknown;
        content?: unknown;
        tags?: unknown;
        expiresInDays?: unknown;
      };
      const kind = String(input.kind ?? "") as MemoKind;
      if (!["lesson", "failure", "shortcut", "preference"].includes(kind)) {
        throw new Error("invalid memo kind");
      }
      const memo = memory.addMemoForAgent({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        kind,
        content: String(input.content ?? ""),
        tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 10) : [],
        sourceTaskId: ctx.taskId,
        expiresInDays: input.expiresInDays == null ? null : Number(input.expiresInDays),
      });
      return { id: memo.id, kind: memo.kind, tags: memo.tags, expiresAt: memo.expiresAt };
    },
  };

  const listBoard: ToolDefinition = {
    name: "memory.board.list",
    description: "List shared board entries with TTL/stale/verified metadata.",
    parameters: {
      type: "object",
      properties: {
        board: { type: "string" },
        status: { type: "string", enum: ["active", "archived"] },
        limit: { type: "number" },
      },
    },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const input = args as { board?: unknown; status?: unknown; limit?: unknown };
      const entries = memory.listBoardForAgent({
        workspaceId: ctx.workspaceId,
        board: typeof input.board === "string" ? input.board : undefined,
        status: input.status === "archived" ? "archived" : "active",
        limit: Math.min(100, Math.max(1, Number(input.limit) || 30)),
      });
      return entries.map((entry) => ({
        id: entry.id,
        board: entry.board,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        pinned: entry.pinned,
        ttlAt: entry.ttlAt,
        stale: entry.stale,
        lastVerifiedAt: entry.lastVerifiedAt,
      }));
    },
  };

  const postBoard: ToolDefinition = {
    name: "memory.board.post",
    description: "Post an atomic entry to a shared blackboard (agent source; no pin/verify/archive).",
    parameters: {
      type: "object",
      properties: {
        board: { type: "string" },
        kind: { type: "string", enum: ["fact", "decision", "question", "warning", "artifact", "link"] },
        content: { type: "string" },
        refs: { type: "array", items: { type: "string" } },
        ttlDays: { type: "number" },
      },
      required: ["board", "kind", "content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const input = args as {
        board?: unknown;
        kind?: unknown;
        content?: unknown;
        refs?: unknown;
        ttlDays?: unknown;
      };
      const kind = String(input.kind ?? "") as BoardKind;
      if (!["fact", "decision", "question", "warning", "artifact", "link"].includes(kind)) {
        throw new Error("invalid board kind");
      }
      const entry = memory.postBoardForAgent({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        board: String(input.board ?? ""),
        kind,
        content: String(input.content ?? ""),
        refs: Array.isArray(input.refs) ? input.refs.map(String).slice(0, 20) : [],
        ttlDays: input.ttlDays == null ? null : Number(input.ttlDays),
      });
      return { id: entry.id, board: entry.board, kind: entry.kind, ttlAt: entry.ttlAt };
    },
  };

  return [search, context, addMemo, listBoard, postBoard];
}
