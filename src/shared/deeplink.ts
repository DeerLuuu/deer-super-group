// C12：hash 路由与深链。
// 格式：#/tasks?t=<taskId> · #/team?t=<taskId> · #/chat?task=<taskId> ·
//       #/mailbox?m=<messageId> · #/board?b=<boardName> · #/settings
// t69：任务页/Run 面板共享 `r=<runId>`（仅在 Run 面板激活时写入，见 App）。
// C10 已把 Router 页合并进任务/对话页，旧 #/router 深链重定向到 #/tasks。

export const ROUTE_TABS = ["tasks", "team", "chat", "mailbox", "board", "settings"] as const;

export type RouteTab = (typeof ROUTE_TABS)[number];

/** 旧 tab 名 → 新 tab（C10 合并 7→6 后的兼容重定向）。 */
const TAB_ALIASES: Record<string, RouteTab> = {
  router: "tasks",
};

export type Route = {
  tab: RouteTab;
  /** 任务/团队页选中的任务 id（`t` 参数）。 */
  task: string | null;
  /** 对话页锁定的任务上下文 id（`task` 参数）。 */
  chatTask: string | null;
  /** 邮箱选中的消息 id（`m` 参数）。 */
  message: string | null;
  /** 黑板选中的板块名（`b` 参数）。 */
  board: string | null;
  /** t69：Run 面板选中的 Run id（`r` 参数；tasks tab 可选）。 */
  run: string | null;
  /** 是否由旧深链（如 #/router）重定向而来。 */
  redirected: boolean;
};

export const DEFAULT_ROUTE: Route = {
  tab: "tasks",
  task: null,
  chatTask: null,
  message: null,
  board: null,
  run: null,
  redirected: false,
};

function isRouteTab(value: string): value is RouteTab {
  return (ROUTE_TABS as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const segment = (path.split("/")[0] ?? "").toLowerCase();
  const params = new URLSearchParams(query);
  const redirected = !isRouteTab(segment) && segment in TAB_ALIASES;
  const tab = isRouteTab(segment) ? segment : (TAB_ALIASES[segment] ?? "tasks");
  return {
    tab,
    task: params.get("t"),
    chatTask: params.get("task"),
    message: params.get("m"),
    board: params.get("b"),
    run: params.get("r"),
    redirected,
  };
}

export type RouteSelection = {
  task?: string | null;
  chatTask?: string | null;
  message?: string | null;
  board?: string | null;
  /** t69：Run 面板选中的 Run id（仅 tasks tab 写入）。 */
  run?: string | null;
};

export function buildHash(tab: RouteTab, selection: RouteSelection = {}): string {
  const params = new URLSearchParams();
  if (tab === "tasks") {
    if (selection.task) params.set("t", selection.task);
    if (selection.run) params.set("r", selection.run);
  } else if (tab === "team") {
    if (selection.task) params.set("t", selection.task);
  } else if (tab === "chat") {
    if (selection.chatTask) params.set("task", selection.chatTask);
  } else if (tab === "mailbox") {
    if (selection.message) params.set("m", selection.message);
  } else if (tab === "board") {
    if (selection.board) params.set("b", selection.board);
  }
  const query = params.toString();
  return `#/${tab}${query ? `?${query}` : ""}`;
}
