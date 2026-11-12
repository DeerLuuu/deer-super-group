import type { MailboxMessage } from "./types.js";

export interface MailboxThreadMessage {
  message: MailboxMessage;
  parentId: string | null;
  depth: number;
  unread: boolean;
}

export interface MailboxThread {
  /** 投影线程 id：根消息 id（不是 DB thread_id）。 */
  threadId: string;
  /** 现有 messages.thread_id 存储键；回复时回传，不新增列。 */
  threadKey: string;
  root: MailboxMessage;
  messages: MailboxThreadMessage[];
  participants: string[];
  unreadCount: number;
  lastActivity: string;
  lastMessage: MailboxMessage;
  subject: string;
  summary: string;
}

export const MAILBOX_MAX_DEPTH = 12;
export const MAILBOX_MAX_INDENT = 6;

const EMPTY_READ_IDS: ReadonlySet<string> = new Set();

function createdAtRank(message: MailboxMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function compareMessages(left: MailboxMessage, right: MailboxMessage): number {
  const byTime = createdAtRank(left) - createdAtRank(right);
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summaryOf(body: string): string {
  const normalized = normalizeText(body);
  return normalized.length > 140 ? `${normalized.slice(0, 139)}…` : normalized;
}

/**
 * t356 M1：邮箱线程投影。
 *
 * 当前 DB 只有 messages.thread_id（没有 parent_id 列）。为了不迁移 schema：
 * - 优先使用消息上可选的 parentId（未来/测试数据）连边；
 * - 同时把同 thread_id 的存量消息聚为一线程；
 * - 无 parentId 的存量消息按现有 thread_id 分组；每个孤儿 thread_id 自己成线程；
 * - 对展示链，若没有显式 parentId，则以同线程上一封为 parent（线性回复链）。
 *
 * threadId 始终取根消息 id；threadKey 保留 DB 的 thread_id，回复时回传该值。
 */
export function deriveMailboxThreads(
  messages: readonly MailboxMessage[],
  readIds: ReadonlySet<string> = EMPTY_READ_IDS,
): MailboxThread[] {
  if (messages.length === 0) return [];
  const ordered = [...messages].sort(compareMessages);
  const byId = new Map(ordered.map((message) => [message.id, message]));
  const parent = new Map<string, string>();

  function find(id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (parent.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parent.get(current)!;
    }
    return current;
  }

  function union(left: string, right: string): void {
    if (left === right) return;
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  }

  for (const message of ordered) {
    if (message.parentId && byId.has(message.parentId)) {
      union(message.id, message.parentId);
    }
  }

  // 现有 thread_id 是唯一可持久化的线程分组；同一存储键的存量消息必须聚合。
  const byThreadKey = new Map<string, string>();
  for (const message of ordered) {
    const key = message.threadId || message.id;
    const first = byThreadKey.get(key);
    if (first) union(message.id, first);
    else byThreadKey.set(key, message.id);
  }

  const components = new Map<string, MailboxMessage[]>();
  for (const message of ordered) {
    const root = find(message.id);
    const bucket = components.get(root) ?? [];
    bucket.push(message);
    components.set(root, bucket);
  }

  const threads: MailboxThread[] = [];
  for (const bucket of components.values()) {
    const sorted = [...bucket].sort(compareMessages);
    const inBucket = new Set(sorted.map((message) => message.id));
    const root =
      sorted.find((message) => !message.parentId || !inBucket.has(message.parentId)) ??
      sorted[0];
    const relation = new Map<string, string | null>();
    for (let index = 0; index < sorted.length; index += 1) {
      const message = sorted[index];
      if (message.id === root.id) {
        relation.set(message.id, null);
      } else if (message.parentId && inBucket.has(message.parentId) && message.parentId !== message.id) {
        relation.set(message.id, message.parentId);
      } else {
        relation.set(message.id, sorted[index - 1]?.id ?? null);
      }
    }

    function depthOf(id: string, visiting = new Set<string>()): number {
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const parentId = relation.get(id) ?? null;
      if (!parentId) return 0;
      return Math.min(MAILBOX_MAX_DEPTH, 1 + depthOf(parentId, visiting));
    }

    const participants: string[] = [];
    for (const message of sorted) {
      for (const participant of [message.from, ...message.to]) {
        if (participant && !participants.includes(participant)) participants.push(participant);
      }
    }
    const lastMessage = sorted[sorted.length - 1];
    const threadMessages: MailboxThreadMessage[] = sorted.map((message) => {
      const parentId = relation.get(message.id) ?? null;
      return {
        message,
        parentId,
        depth: depthOf(message.id),
        unread: !readIds.has(message.id),
      };
    });
    threads.push({
      threadId: root.id,
      threadKey: root.threadId || root.id,
      root,
      messages: threadMessages,
      participants,
      unreadCount: threadMessages.filter((message) => message.unread).length,
      lastActivity: lastMessage.createdAt,
      lastMessage,
      subject: root.subject || lastMessage.subject || "(无主题)",
      summary: summaryOf(lastMessage.body) || summaryOf(root.body),
    });
  }

  return threads.sort((left, right) => {
    const byActivity = Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
    return Number.isFinite(byActivity) && byActivity !== 0
      ? byActivity
      : right.threadId.localeCompare(left.threadId);
  });
}

export function filterMailboxThreads(
  threads: readonly MailboxThread[],
  query: string,
  member: string | null,
): MailboxThread[] {
  const needle = query.trim().toLowerCase();
  return threads.filter((thread) => {
    if (member && !thread.participants.includes(member)) return false;
    if (!needle) return true;
    const haystack = [
      thread.subject,
      thread.summary,
      thread.root.from,
      thread.root.to.join(" "),
      ...thread.messages.map((entry) => entry.message.body),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function mailboxParticipants(threads: readonly MailboxThread[]): string[] {
  const names = new Set<string>();
  for (const thread of threads) {
    for (const participant of thread.participants) names.add(participant);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function totalMailboxUnread(threads: readonly MailboxThread[]): number {
  return threads.reduce((total, thread) => total + thread.unreadCount, 0);
}

/** UI-only read state 的 localStorage 键（按工作区隔离；不写 DB）。 */
export function mailboxReadStorageKey(workspaceId: string): string {
  return `deer.mailbox.read.${workspaceId}`;
}

export function parseMailboxReadIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function serializeMailboxReadIds(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids]);
}
