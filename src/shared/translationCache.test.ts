import { describe, expect, it } from "vitest";
import { translationCacheNeedsInvalidation } from "./translationCache.js";

describe("t329 translation cache invalidation", () => {
  it("invalidates only when both prior and next settings fingerprints differ", () => {
    expect(translationCacheNeedsInvalidation(null, "a")).toBe(false);
    expect(translationCacheNeedsInvalidation("a", null)).toBe(false);
    expect(translationCacheNeedsInvalidation("a", "a")).toBe(false);
    expect(translationCacheNeedsInvalidation("a", "b")).toBe(true);
  });
});
