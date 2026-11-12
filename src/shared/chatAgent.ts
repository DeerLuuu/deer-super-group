import type { Agent } from "./types.js";

/** t424：对话成员解析。无效/已删除 agent 回退 Router，不猜测其它成员。 */
export function resolveChatAgent(agents: Agent[], requestedId: string | null): Agent | null {
  if (requestedId) {
    const requested = agents.find((agent) => agent.id === requestedId);
    if (requested) return requested;
  }
  return agents.find((agent) => agent.isRouter) ?? null;
}

export type ChatAgentOption = {
  id: string;
  name: string;
  role: string;
  isRouter: boolean;
  model: string | null;
  permission: Agent["permission"];
  status: Agent["status"];
};

export function chatAgentOptions(agents: Agent[]): ChatAgentOption[] {
  return [...agents]
    .sort((left, right) => {
      if (left.isRouter !== right.isRouter) return left.isRouter ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      isRouter: agent.isRouter,
      model: agent.model,
      permission: agent.permission,
      status: agent.status,
    }));
}

/** 同一 workspace 内不同 agent 可并行；abort/cancel 必须按复合 key 隔离。 */
export function chatAbortKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

/** /clear /compact /team 只能走 Router 会话。 */
export function isRouterOnlyChatCommand(text: string): boolean {
  return /^\/(?:clear|compact|team)(?:\s|$)/i.test(text.trim());
}

