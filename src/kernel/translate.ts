/**
 * t179：Bing 网页翻译接口。
 *
 * 不用 Azure key：从 bing.com/translator 页取 IG / data-iid /
 * params_AbusePreventionHelper，再请求 /ttranslatev3。
 * 只翻译思考文本；失败由调用方降级为不显示机翻。
 */

const TRANSLATE_HOSTS = ["cn.bing.com", "www.bing.com"] as const;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_CHUNK = 900;
const CACHE_LIMIT = 300;

type BingSession = {
  host: string;
  ig: string;
  iid: string;
  key: string;
  token: string;
  cookies: string;
  expiresAt: number;
  counter: number;
};

type BingTranslationResponse = Array<{
  translations?: Array<{ text?: string; to?: string }>;
  detectedLanguage?: { language?: string };
}>;

export function isMostlyChinese(text: string): boolean {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  if (cjk === 0) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk >= 8 && cjk >= latin * 0.25;
}

/** 按段落/句号切分，避免超过 Bing Web 的 1000 字符限制。 */
export function splitTranslationChunks(text: string, limit = MAX_CHUNK): string[] {
  const source = text.trim();
  if (!source) return [];
  const pieces = source.split(/(?<=[.!?。！？])\s+|\n+/);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.length > limit) {
      flush();
      for (let index = 0; index < piece.length; index += limit) {
        chunks.push(piece.slice(index, index + limit));
      }
      continue;
    }
    if (current && current.length + piece.length + 1 > limit) flush();
    current = current ? `${current} ${piece}` : piece;
  }
  flush();
  return chunks;
}

export class BingTranslator {
  private session: BingSession | null = null;
  private readonly cache = new Map<string, string>();

  async translate(text: string, target = "zh-Hans"): Promise<string> {
    const source = text.trim();
    if (!source) return "";
    if (isMostlyChinese(source)) return source;
    const cacheKey = `${target}\u0000${source}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const chunks = splitTranslationChunks(source);
    const translated: string[] = [];
    for (const chunk of chunks) {
      translated.push(await this.translateChunk(chunk, target));
    }
    const result = translated.join(" ");
    this.cache.set(cacheKey, result);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return result;
  }

  private async translateChunk(text: string, target: string): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await this.getSession(attempt > 0);
        const body = new URLSearchParams({
          fromLang: "auto-detect",
          text,
          to: target,
          token: session.token,
          key: session.key,
        });
        const response = await fetch(
          `https://${session.host}/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(
            session.ig,
          )}&IID=${encodeURIComponent(`${session.iid}.${session.counter}`)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": USER_AGENT,
              referer: `https://${session.host}/translator`,
              cookie: session.cookies,
            },
            body,
            signal: AbortSignal.timeout(15_000),
          },
        );
        session.counter += 1;
        const raw = await response.text();
        if (!response.ok) {
          throw new Error(`Bing translate HTTP ${response.status}`);
        }
        const parsed = JSON.parse(raw) as BingTranslationResponse;
        const value = parsed?.[0]?.translations?.[0]?.text;
        if (typeof value === "string" && value.trim()) return value;
        throw new Error("Bing translate returned an empty response");
      } catch (error) {
        lastError = error;
        this.session = null;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Bing translate failed");
  }

  private async getSession(force: boolean): Promise<BingSession> {
    if (!force && this.session && Date.now() < this.session.expiresAt - 60_000) {
      return this.session;
    }
    let lastError: unknown = null;
    for (const host of TRANSLATE_HOSTS) {
      try {
        this.session = await this.createSession(host);
        return this.session;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Bing translate unavailable");
  }

  private async createSession(host: string): Promise<BingSession> {
    const response = await fetch(`https://${host}/translator`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Bing translator page HTTP ${response.status}`);
    const html = await response.text();
    const ig = html.match(/IG:"([^"]+)"/)?.[1];
    const iid =
      html.match(/id="rich_tta"[^>]*data-iid="([^"]+)"/)?.[1] ??
      html.match(/data-iid="([^"]+)"/)?.[1];
    const abuse = html.match(/var params_AbusePreventionHelper = \[([\s\S]*?)\];/)?.[1];
    if (!ig || !iid || !abuse) {
      throw new Error("Bing translator page missing token params");
    }
    const parts = abuse.replaceAll('"', "").split(",");
    const key = parts[0]?.trim();
    const token = parts[1]?.trim();
    if (!key || !token) throw new Error("Bing translator token malformed");
    const cookies = (response.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const expiresAt = Number(key);
    return {
      host,
      ig,
      iid,
      key,
      token,
      cookies,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60_000,
      counter: 1,
    };
  }
}
