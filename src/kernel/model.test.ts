import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmSettings } from "../shared/types.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import {
  OpenAiClient,
  createLlmClient,
  fetchModelList,
  resolveApiKey,
  resolveBaseUrl,
} from "./model.js";

const base: LlmSettings = {
  baseUrl: "https://example.com/v1",
  baseUrlEnv: "DEER_TEST_BASE_URL",
  apiKey: "",
  apiKeyEnv: "DEER_TEST_API_KEY",
  providers: [
    defaultProviderProfile(
      {
        baseUrl: "https://example.com/v1",
        baseUrlEnv: "DEER_TEST_BASE_URL",
        apiKey: "",
        apiKeyEnv: "DEER_TEST_API_KEY",
      },
      "provider_default",
      "Test Provider",
    ),
  ],
  model: "test-model",
  models: [defaultModelProfile("test-model")],
  mock: false,
};

afterEach(() => {
  delete process.env.DEER_TEST_API_KEY;
  delete process.env.DEER_TEST_BASE_URL;
});

describe("resolveApiKey", () => {
  it("prefers the environment variable", () => {
    process.env.DEER_TEST_API_KEY = "env-secret";
    const resolved = resolveApiKey({
      ...base,
      apiKey: "local-secret",
      apiKeyEnv: "DEER_TEST_API_KEY",
    });
    expect(resolved).toEqual({ key: "env-secret", source: "env" });
  });

  it("falls back to the local key when the env var is missing", () => {
    const resolved = resolveApiKey({
      ...base,
      apiKey: "local-secret",
      apiKeyEnv: "DEER_TEST_API_KEY",
    });
    expect(resolved).toEqual({ key: "local-secret", source: "local" });
  });

  it("returns none when neither source is configured", () => {
    expect(resolveApiKey(base)).toEqual({ key: "", source: "none" });
  });

  it("fails loudly when real mode has no key", () => {
    expect(() => createLlmClient(base)).toThrow(/未配置 API Key/);
  });
});

describe("resolveBaseUrl", () => {
  it("prefers the base URL environment variable", () => {
    process.env.DEER_TEST_BASE_URL = "https://env.example.com/v1/";
    expect(
      resolveBaseUrl({
        ...base,
        baseUrl: "https://local.example.com/v1",
        baseUrlEnv: "DEER_TEST_BASE_URL",
      }),
    ).toBe("https://env.example.com/v1");
  });

  it("falls back to the stored base URL", () => {
    expect(
      resolveBaseUrl({
        ...base,
        baseUrl: "https://local.example.com/v1",
        baseUrlEnv: "DEER_TEST_BASE_URL",
      }),
    ).toBe("https://local.example.com/v1");
  });
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("fetchModelList", () => {
  it("reads OpenAI-compatible model lists", async () => {
    await withServer(
      (request, response) => {
        if (request.url === "/v1/models") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
          return;
        }
        response.writeHead(404);
        response.end();
      },
      async (baseUrl) => {
        const models = await fetchModelList({
          ...base,
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-key",
        });
        expect(models).toEqual(["model-a", "model-b"]);
      },
    );
  });

  it("falls back to /v1/models when /models is 404", async () => {
    await withServer(
      (request, response) => {
        if (request.url === "/v1/models") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ models: ["deepseek-chat"] }));
          return;
        }
        response.writeHead(404);
        response.end();
      },
      async (baseUrl) => {
        const models = await fetchModelList({
          ...base,
          baseUrl,
          apiKey: "test-key",
        });
        expect(models).toEqual(["deepseek-chat"]);
      },
    );
  });

  it("surfaces HTTP errors with the endpoint URL", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid key" } }));
      },
      async (baseUrl) => {
        await expect(
          fetchModelList({ ...base, baseUrl: `${baseUrl}/v1`, apiKey: "bad-key" }),
        ).rejects.toThrow(/HTTP 401/);
      },
    );
  });
});

describe("DeepSeek thinking mode", () => {
  it("sends thinking params and captures reasoning_content", async () => {
    let requestBody: Record<string, unknown> = {};
    await withServer(
      (request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        request.on("end", () => {
          requestBody = JSON.parse(raw) as Record<string, unknown>;
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { reasoning_content: "think" } }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: "answer" } }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      },
      async (baseUrl) => {
        const client = new OpenAiClient(`${baseUrl}/v1`, "key");
        const completion = await client.complete({
          model: "deepseek-flash",
          messages: [{ role: "user", content: "hi" }],
          maxOutputTokens: 100,
          reasoningEffort: "high",
          thinkingEnabled: true,
          thinkingStyle: "deepseek",
        });

        expect(completion.reasoning).toBe("think");
        expect(completion.text).toBe("answer");
        expect(requestBody.thinking).toEqual({ type: "enabled" });
        expect(requestBody.reasoning_effort).toBe("high");
        expect(requestBody.max_tokens).toBe(100);
      },
    );
  });
});
