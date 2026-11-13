import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "../shared/types.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import { AppService } from "./service.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("t475 real sendChat token path", () => {
  it("streams token deltas through AppService.sendChat without a store mock", async () => {
    const server = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      request.resume();
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (delta: Record<string, unknown>) => {
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-t475", choices: [{ index: 0, delta }] })}\n\n`);
      };
      send({ content: "你" });
      send({ content: "好" });
      send({ content: "，t475" });
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl-t475", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-chat-token-"));
    const workspacePath = path.join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n", "utf8");
    const service = new AppService(path.join(root, "data"));
    cleanup.push(() => {
      service.close();
      rmSync(root, { recursive: true, force: true });
      void new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const workspace = await service.openWorkspace(workspacePath);
    const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
    service.saveSettings({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      baseUrlEnv: "",
      apiKey: "test-key",
      apiKeyEnv: "",
      providers: [
        defaultProviderProfile(
          {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test-key",
            baseUrlEnv: "",
            apiKeyEnv: "",
          },
          "provider_default",
          "Local SSE",
        ),
      ],
      model: "provider_default:deepseek-flash",
      models: [defaultModelProfile("deepseek-flash")],
      mock: false,
    });

    const events: ChatEvent[] = [];
    const off = service.onChatEvent((event) => events.push(event));
    const reply = await service.sendChat(workspace.id, router.id, "t475 token evidence");
    off();

    const deltas = events
      .filter((event): event is Extract<ChatEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    expect(deltas).toBe("你好，t475");
    expect(reply?.content).toBe("你好，t475");
    expect(events.every((event) => event.agentId === router.id)).toBe(true);
  }, 20_000);
});
