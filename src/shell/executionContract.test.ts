import { describe, expect, it } from "vitest";
import type { Agent } from "../shared/types.js";
import { taskExecutionContract } from "./executionContract.js";

const owner: Agent = {
  id: "a1",
  workspaceId: "ws",
  name: "Ren",
  role: "Engineer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: "deepseek-flash",
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("t337 task execution contract", () => {
  it("projects model/permission/FT/context from existing owner and session", () => {
    const contract = taskExecutionContract(
      { id: "t1", ownerId: "a1" },
      [owner],
      true,
      3,
    );
    expect(contract).toMatchObject({
      ownerId: "a1",
      ownerName: "Ren",
      model: "deepseek-flash",
      permission: "workspace_write",
      permissionLabel: "工作区内修改",
      fullThrottle: "开启（会话级）",
      context: "trace 3 条",
      source: "owner",
    });
  });

  it("shows default model when owner has no model override", () => {
    const contract = taskExecutionContract(
      { id: "t1", ownerId: "a1" },
      [{ ...owner, model: null }],
      false,
      0,
    );
    expect(contract.model).toBe("默认模型");
    expect(contract.fullThrottle).toBe("关闭（会话级）");
    expect(contract.context).toBe("无 trace");
  });

  it("shows unknown/unavailable without guessing", () => {
    expect(
      taskExecutionContract({ id: "t1", ownerId: null }, [], false, 0),
    ).toMatchObject({
      ownerName: "未分配",
      model: "未知",
      permission: "未知",
      permissionLabel: "未知",
      source: "unassigned",
    });
    expect(
      taskExecutionContract({ id: "t1", ownerId: "missing" }, [], false, 0),
    ).toMatchObject({
      ownerName: "负责人不可用",
      model: "未知",
      source: "unavailable",
    });
  });
});
