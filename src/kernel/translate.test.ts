import { describe, expect, it } from "vitest";
import { isMostlyChinese, splitTranslationChunks } from "./translate.js";

describe("t179 Bing translation helpers", () => {
  it("detects Chinese thinking and skips translating it", () => {
    expect(isMostlyChinese("我先检查项目文件，然后读取配置。")).toBe(true);
    expect(isMostlyChinese("I will inspect the project files first.")).toBe(false);
    expect(isMostlyChinese("混合 mixed 文本")).toBe(false);
  });

  it("splits long thinking into Bing-sized chunks", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Sentence number ${index}.`).join(" ");
    const chunks = splitTranslationChunks(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.join(" ")).toContain("Sentence number 39.");
  });

  it("keeps a short segment intact", () => {
    expect(splitTranslationChunks("I will read the file.", 900)).toEqual([
      "I will read the file.",
    ]);
  });
});
