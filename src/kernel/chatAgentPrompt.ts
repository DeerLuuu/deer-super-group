import type { Agent, Workspace } from "../shared/types.js";

/**
 * t424：成员对话 system prompt。
 * 只含成员身份/角色/工作区/成员自定义指令；Router 的 team/tasks 规划、
 * INTERACTIVE_PROMPT_V1、画布/提问协议与压缩摘要都不进入成员对话。
 */
export function buildAgentSystemPrompt(agent: Agent, workspace: Workspace): string {
  return [
    `You are ${agent.name} (${agent.role}) in DeerSuperGroup, an AI team.`,
    `Workspace: ${workspace.name} at ${workspace.path}`,
    workspace.overview ? `Workspace overview:\n${workspace.overview}` : "",
    agent.systemPrompt ? `Instructions:\n${agent.systemPrompt}` : "",
    agent.persona ? `Persona:\n${agent.persona}` : "",
    agent.agentsMd ? `AGENTS.md:\n${agent.agentsMd}` : "",
    "You are chatting directly with the user. Be concise, ask for missing information, and suggest next steps when useful.",
    "Tool access is governed by your permission mode and workspace policy. Read/inspect before editing; request approval when policy requires it; never claim a tool is unavailable without trying it.",
  ]
    .filter(Boolean)
    .join("\n");
}
