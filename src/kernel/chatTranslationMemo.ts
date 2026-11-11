/**
 * t168：历史思考翻译的 renderer 会话缓存。
 *
 * - 同一文本只请求一次；并发请求合并；
 * - 实时段完成后 prime，历史段直接复用，不再调用翻译接口；
 * - 不持久化译文，workspace 切换时 clear。
 */
export interface ChatTranslationMemo {
  translate(text: string): Promise<string>;
  /** 实时翻译或外部缓存写入（不触发请求）。 */
  prime(text: string, translation: string): void;
  clear(): void;
}

export function createChatTranslationMemo(
  request: (text: string) => Promise<string>,
  maxEntries = 200,
): ChatTranslationMemo {
  const cache = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let generation = 0;
  const remember = (text: string, translation: string) => {
    cache.delete(text);
    cache.set(text, translation);
    while (cache.size > Math.max(1, maxEntries)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };
  return {
    translate(text: string): Promise<string> {
      const cached = cache.get(text);
      if (cached !== undefined) return Promise.resolve(cached);
      const existing = pending.get(text);
      if (existing) return existing;
      const requestGeneration = generation;
      let promise: Promise<string>;
      promise = request(text)
        .then((translation) => {
          // clear() 之后旧请求不得回写缓存，也不得删除新请求的 pending。
          if (generation !== requestGeneration) return translation;
          remember(text, translation);
          if (pending.get(text) === promise) pending.delete(text);
          return translation;
        })
        .catch((error: unknown) => {
          if (generation === requestGeneration && pending.get(text) === promise) {
            pending.delete(text);
          }
          throw error;
        });
      pending.set(text, promise);
      return promise;
    },
    prime(text: string, translation: string): void {
      if (!text.trim()) return;
      remember(text, translation);
    },
    clear(): void {
      generation += 1;
      cache.clear();
      pending.clear();
    },
  };
}
