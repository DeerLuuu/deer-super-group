import { describe, expect, it } from "vitest";
import { buildHash, parseHash } from "./deeplink";

describe("parseHash（C12 深链解析）", () => {
  it("空 hash 落到任务页", () => {
    expect(parseHash("")).toEqual({
      tab: "tasks",
      task: null,
      chatTask: null,
      message: null,
      board: null,
      run: null,
      redirected: false,
    });
  });

  it("解析 6 个合法 tab", () => {
    for (const tab of ["tasks", "team", "chat", "mailbox", "board", "settings"] as const) {
      expect(parseHash(`#/${tab}`).tab).toBe(tab);
    }
  });

  it("解析任务深链 #/tasks?t=t3", () => {
    const route = parseHash("#/tasks?t=t3");
    expect(route.tab).toBe("tasks");
    expect(route.task).toBe("t3");
  });

  it("解析 Run 面板深链 #/tasks?t=t3&r=run-2", () => {
    const route = parseHash("#/tasks?t=t3&r=run-2");
    expect(route.tab).toBe("tasks");
    expect(route.task).toBe("t3");
    expect(route.run).toBe("run-2");
  });

  it("解析对话任务上下文 #/chat?task=t5", () => {
    const route = parseHash("#/chat?task=t5");
    expect(route.tab).toBe("chat");
    expect(route.chatTask).toBe("t5");
  });

  it("解析邮箱与黑板深链", () => {
    expect(parseHash("#/mailbox?m=m1").message).toBe("m1");
    expect(parseHash("#/board?b=general").board).toBe("general");
  });

  it("旧 #/router 深链重定向到任务页（C10 合并 7→6）", () => {
    const route = parseHash("#/router");
    expect(route.tab).toBe("tasks");
    expect(route.redirected).toBe(true);
  });

  it("未知 tab 回退到任务页且不标记重定向", () => {
    const route = parseHash("#/nope");
    expect(route.tab).toBe("tasks");
    expect(route.redirected).toBe(false);
  });
});

describe("buildHash（C12 深链生成）", () => {
  it("任务页携带选中任务", () => {
    expect(buildHash("tasks", { task: "t3" })).toBe("#/tasks?t=t3");
  });

  it("任务页携带 Run 选中（t69 Run 面板）", () => {
    expect(buildHash("tasks", { task: "t3", run: "run-2" })).toBe(
      "#/tasks?t=t3&r=run-2",
    );
    expect(parseHash("#/tasks?t=t3&r=run-2").run).toBe("run-2");
  });

  it("对话页携带任务上下文", () => {
    expect(buildHash("chat", { chatTask: "t5" })).toBe("#/chat?task=t5");
  });

  it("邮箱与黑板携带各自选中", () => {
    expect(buildHash("mailbox", { message: "m1" })).toBe("#/mailbox?m=m1");
    expect(buildHash("board", { board: "general" })).toBe("#/board?b=general");
  });

  it("非当前页的选中参数不会写入 hash", () => {
    expect(buildHash("settings", { task: "t3", message: "m1" })).toBe("#/settings");
    expect(buildHash("team", { task: null })).toBe("#/team");
  });

  it("永不生成旧 #/router 深链", () => {
    // router 不是 ROUTE_TABS 成员，类型层面即禁止；运行时防御检查：
    expect(buildHash("tasks")).not.toContain("router");
  });

  it("parse(build(route)) 往返一致", () => {
    const hash = buildHash("chat", { chatTask: "t9" });
    const route = parseHash(hash);
    expect(route.tab).toBe("chat");
    expect(route.chatTask).toBe("t9");
  });
});
