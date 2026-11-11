import { describe, expect, it, vi } from "vitest";
import { createChatTranslationMemo } from "./chatTranslationMemo.js";

describe("t168 chat translation memo", () => {
  it("deduplicates concurrent and repeated requests", async () => {
    const request = vi.fn(async (text: string) => `译:${text}`);
    const memo = createChatTranslationMemo(request);
    const [first, second] = await Promise.all([memo.translate("hello"), memo.translate("hello")]);
    expect(first).toBe("译:hello");
    expect(second).toBe("译:hello");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await memo.translate("hello")).toBe("译:hello");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await memo.translate("world")).toBe("译:world");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reuses live translations via prime without a request", async () => {
    const request = vi.fn(async (text: string) => `译:${text}`);
    const memo = createChatTranslationMemo(request);
    memo.prime("live reasoning", "实时译文");
    expect(await memo.translate("live reasoning")).toBe("实时译文");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not cache failures and supports clearing on workspace switch", async () => {
    let fail = true;
    const request = vi.fn(async (text: string) => {
      if (fail) throw new Error("network");
      return `译:${text}`;
    });
    const memo = createChatTranslationMemo(request);
    await expect(memo.translate("retry")).rejects.toThrow(/network/);
    fail = false;
    expect(await memo.translate("retry")).toBe("译:retry");
    memo.prime("cached", "译文");
    memo.clear();
    expect(await memo.translate("cached")).toBe("译:cached");
  });

  it("caps the cache without dropping the newest entry", async () => {
    const request = vi.fn(async (text: string) => `译:${text}`);
    const memo = createChatTranslationMemo(request, 2);
    await memo.translate("a");
    await memo.translate("b");
    await memo.translate("c");
    expect(await memo.translate("c")).toBe("译:c");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
