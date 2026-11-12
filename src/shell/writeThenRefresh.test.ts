import { describe, expect, it, vi } from "vitest";
import { writeThenRefresh } from "./writeThenRefresh.js";

describe("t257 writeThenRefresh", () => {
  it("treats write success as committed even when refresh throws", async () => {
    const write = vi.fn(async () => ({ id: "task-1" }));
    const after = vi.fn(async () => {
      throw new Error("refresh failed");
    });
    const result = await writeThenRefresh(write, after);
    expect(result.value).toEqual({ id: "task-1" });
    expect(result.postError).toBeInstanceOf(Error);
    expect(write).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("rejects and does not run refresh when the write itself fails", async () => {
    const write = vi.fn(async () => {
      throw new Error("write failed");
    });
    const after = vi.fn(async () => {});
    await expect(writeThenRefresh(write, after)).rejects.toThrow("write failed");
    expect(after).not.toHaveBeenCalled();
  });
});
