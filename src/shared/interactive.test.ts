import { describe, expect, it } from "vitest";
import {
  CANVAS_LIMITS,
  INTERACTIVE_PROMPT_V1,
  chatBlockKey,
  compressInteractiveForModel,
  formatQuestionAnswer,
  hasInteractiveFence,
  parseCanvasJson,
  parseChatContent,
  parseQuestionJson,
  questionExpiresAt,
  sanitizeText,
  stripInteractiveForStreaming,
  validateQuestionAnswers,
  type DeerCanvas,
  type DeerQuestion,
} from "./interactive.js";

/**
 * t64 协议层单测（设计 §13.3 / AC-01/07/08/27/30/31/36）。
 */

function canvasJson(overrides: Partial<DeerCanvas> = {}): string {
  const base: DeerCanvas = {
    protocol: "deer-canvas",
    version: 1,
    kind: "flowchart",
    title: "实现流程",
    nodes: [
      { id: "a", label: "写协议", kind: "step", status: "done" },
      { id: "b", label: "渲染画布", kind: "step", status: "active" },
      { id: "c", label: "评审", kind: "step", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "flow" },
      { id: "e2", from: "b", to: "c", kind: "flow" },
    ],
    groups: [],
  };
  return JSON.stringify({ ...base, ...overrides });
}

function questionJson(overrides: Partial<DeerQuestion> = {}): string {
  const base = {
    protocol: "deer-question",
    version: 1,
    title: "确认范围",
    fields: [
      {
        id: "scope",
        kind: "multi",
        label: "P0 必须包含",
        required: true,
        options: [
          { id: "flow", label: "流程图" },
          { id: "ask", label: "提问" },
        ],
      },
    ],
  };
  return JSON.stringify({ ...base, ...overrides });
}

function fence(language: string, body: string): string {
  return ["```" + language, body, "```"].join("\n");
}

function niceCanvas(overrides: Partial<DeerCanvas> = {}): DeerCanvas {
  const parsed = parseCanvasJson(canvasJson(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe("deer-* fence 解析（AC-01）", () => {
  it("识别 deer-canvas / deer-question 并切分文本段", () => {
    const content = [
      "下面是流程：",
      "",
      fence("deer-canvas", canvasJson()),
      "",
      "还有几个问题：",
      fence("deer-question", questionJson()),
      "结束。",
    ].join("\n");
    const blocks = parseChatContent(content, { role: "assistant", messageId: "msg_1" });
    const types = blocks.map((block) => block.type);
    expect(types).toEqual(["text", "canvas", "text", "question", "text"]);
    const canvasBlock = blocks[1];
    expect(canvasBlock.type).toBe("canvas");
    if (canvasBlock.type === "canvas") {
      expect(canvasBlock.artifact.kind).toBe("flowchart");
      expect(canvasBlock.artifact.nodes).toHaveLength(3);
      expect(canvasBlock.blockIndex).toBe(0);
      expect(canvasBlock.key).toBe("msg_1#b0");
    }
    const questionBlock = blocks[3];
    if (questionBlock.type === "question") {
      expect(questionBlock.question.fields).toHaveLength(1);
      expect(questionBlock.blockIndex).toBe(1);
      expect(questionBlock.key).toBe("msg_1#b1");
    }
  });

  it("其他语言 fence 保持 Markdown 行为（不拦截）", () => {
    const content = ["```ts", "const x = 1;", "```"].join("\n");
    const blocks = parseChatContent(content, { role: "assistant" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("行内代码 deer-canvas 不触发解析", () => {
    const content = "这是 `deer-canvas` 行内代码，不是 fence。";
    const blocks = parseChatContent(content, { role: "assistant" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("语言标识大小写不敏感、两侧空白允许；带额外信息不识别", () => {
    const upper = parseChatContent(`\`\`\`  DEER-CANVAS  \n${canvasJson()}\n\`\`\``, {
      role: "assistant",
    });
    expect(upper.some((block) => block.type === "canvas")).toBe(true);

    const extra = parseChatContent(`\`\`\`deer-canvas foo\n${canvasJson()}\n\`\`\``, {
      role: "assistant",
    });
    expect(extra.every((block) => block.type === "text")).toBe(true);
  });

  it("~ 与 4 个反引号 fence 均可识别（结束 fence 长度不小于起始）", () => {
    const tilde = parseChatContent(`~~~deer-canvas\n${canvasJson()}\n~~~`, { role: "assistant" });
    expect(tilde.some((block) => block.type === "canvas")).toBe(true);
    const four = parseChatContent(`\`\`\`\`deer-canvas\n${canvasJson()}\n\`\`\`\``, {
      role: "assistant",
    });
    expect(four.some((block) => block.type === "canvas")).toBe(true);
    // 结束 fence 长度不足 → 未闭合
    const broken = parseChatContent(`\`\`\`\`deer-canvas\n${canvasJson()}\n\`\`\``, {
      role: "assistant",
    });
    expect(broken.some((block) => block.type === "canvas_error")).toBe(true);
  });

  it("CRLF 正文可解析", () => {
    const content = `前言\r\n${fence("deer-canvas", canvasJson()).replace(/\n/g, "\r\n")}\r\n结尾`;
    const blocks = parseChatContent(content, { role: "assistant" });
    expect(blocks.some((block) => block.type === "canvas")).toBe(true);
  });

  it("未闭合 fence（消息结束）→ E_UNCLOSED 回退", () => {
    const content = "前言\n```deer-canvas\n{\"protocol\":\"deer-canvas\"";
    const blocks = parseChatContent(content, { role: "assistant" });
    const fallback = blocks.find((block) => block.type === "canvas_error");
    expect(fallback).toBeDefined();
    if (fallback && fallback.type === "canvas_error") {
      expect(fallback.error.code).toBe("E_UNCLOSED");
      expect(fallback.raw).toContain("protocol");
    }
  });

  it("用户/系统消息永远纯文本（防伪造，AC-30）", () => {
    const content = fence("deer-canvas", canvasJson());
    const userBlocks = parseChatContent(content, { role: "user" });
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0].type).toBe("text");
    const systemBlocks = parseChatContent(content, { role: "system" });
    expect(systemBlocks[0].type).toBe("text");
  });

  it("无 deer-* 子串时走快路径（单文本段、内容不变）", () => {
    const content = "# 标题\n\n正文";
    expect(hasInteractiveFence(content)).toBe(false);
    const blocks = parseChatContent(content, { role: "assistant" });
    expect(blocks).toEqual([{ type: "text", text: content }]);
  });

  it("一条消息第 4 个画布 / 第 7 个交互块 → E_LIMIT（前 3 个正常）", () => {
    const canvases = Array.from({ length: 4 }, (_, index) =>
      fence("deer-canvas", canvasJson({ title: `画布 ${index}` })),
    ).join("\n\n");
    const blocks = parseChatContent(canvases, { role: "assistant", messageId: "m" });
    const rendered = blocks.filter((block) => block.type === "canvas");
    const errors = blocks.filter((block) => block.type === "canvas_error");
    expect(rendered).toHaveLength(3);
    expect(errors).toHaveLength(1);
    if (errors[0].type === "canvas_error") {
      expect(errors[0].error.code).toBe("E_LIMIT");
    }

    const mix = [
      ...Array.from({ length: 3 }, (_, index) =>
        fence("deer-canvas", canvasJson({ title: `C${index}` })),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        fence("deer-question", questionJson({ title: `Q${index}` })),
      ),
    ].join("\n\n");
    const mixedBlocks = parseChatContent(mix, { role: "assistant", messageId: "m2" });
    const limited = mixedBlocks.filter(
      (block) =>
        (block.type === "canvas_error" || block.type === "question_error") &&
        block.error.code === "E_LIMIT",
    );
    // 画布 3 个后 Q1..Q3 正常，Q4 因总块数 6 上限被拒。
    expect(limited).toHaveLength(1);
  });
});

describe("画布 schema 校验（AC-07/08/27）", () => {
  it("合法画布返回归一化结果", () => {
    const result = parseCanvasJson(canvasJson());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.protocol).toBe("deer-canvas");
      expect(result.value.version).toBe(1);
      expect(result.value.direction).toBe("TB");
      expect(result.value.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    }
  });

  it("坏 JSON → E_JSON", () => {
    const result = parseCanvasJson("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_JSON");
  });

  it("protocol 不匹配 → E_PROTOCOL", () => {
    const result = parseCanvasJson(JSON.stringify({ protocol: "other", version: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_PROTOCOL");
  });

  it("version > 1 → E_VERSION", () => {
    const result = parseCanvasJson(canvasJson({ version: 2 as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_VERSION");
  });

  it("未知字段（style/html/url/x/y）→ E_SCHEMA", () => {
    for (const extra of ['"style":"color:red"', '"html":"<b>x</b>"', '"x":10', '"url":"https://x"']) {
      const raw = `{"protocol":"deer-canvas","version":1,"kind":"flowchart","title":"T",${extra},"nodes":[{"id":"a","label":"A"}]}`;
      const result = parseCanvasJson(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("E_SCHEMA");
        expect(result.error.detail ?? "").toMatch(/style|html|x|url|Unrecognized|unrecognized/i);
      }
    }
  });

  it("节点 id 重复 / 边端点不存在 / 自环 / 分组引用不存在 → E_SCHEMA", () => {
    const dup = parseCanvasJson(
      canvasJson({
        nodes: [
          { id: "a", label: "A", kind: "step", status: "planned" },
          { id: "a", label: "B", kind: "step", status: "planned" },
        ],
        edges: [],
      }),
    );
    expect(dup.ok).toBe(false);

    const missing = parseCanvasJson(
      canvasJson({ edges: [{ from: "a", to: "ghost", kind: "flow" }] }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.detail).toContain("ghost");

    const self = parseCanvasJson(
      canvasJson({ edges: [{ from: "a", to: "a", kind: "flow" }] }),
    );
    expect(self.ok).toBe(false);

    const groupRef = parseCanvasJson(
      canvasJson({
        nodes: [{ id: "a", label: "A", kind: "step", status: "planned", groupId: "nope" }],
        edges: [],
      }),
    );
    expect(groupRef.ok).toBe(false);
  });

  it("节点 81 / 边 241 → E_SCHEMA", () => {
    const tooManyNodes = Array.from({ length: 81 }, (_, index) => ({
      id: `n${index}`,
      label: `节点 ${index}`,
      kind: "step" as const,
      status: "planned" as const,
    }));
    expect(parseCanvasJson(canvasJson({ nodes: tooManyNodes, edges: [] })).ok).toBe(false);

    const nodes = Array.from({ length: 3 }, (_, index) => ({
      id: `n${index}`,
      label: `节点 ${index}`,
      kind: "step" as const,
      status: "planned" as const,
    }));
    const edges = Array.from({ length: 241 }, () => ({ from: "n0", to: "n1", kind: "flow" as const }));
    expect(parseCanvasJson(canvasJson({ nodes, edges })).ok).toBe(false);
  });

  it("超过 64KB → E_TOO_LARGE（不进入 JSON.parse）", () => {
    const raw = `{"protocol":"deer-canvas","version":1,"kind":"flowchart","title":"${"x".repeat(CANVAS_LIMITS.jsonBytes + 10)}`;
    const result = parseCanvasJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_TOO_LARGE");
  });

  it("重复边去重并给 W_DUP_EDGE；缺失边 id 自动生成", () => {
    const result = parseCanvasJson(
      canvasJson({
        edges: [
          { from: "a", to: "b", kind: "flow" },
          { from: "a", to: "b", kind: "flow" },
          { from: "b", to: "c", kind: "depends" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.edges).toHaveLength(2);
      expect(result.warnings).toContain("W_DUP_EDGE");
      expect(result.value.edges[0].id).toBeTruthy();
      expect(result.value.edges[1].id).toBeTruthy();
      expect(result.value.edges[0].id).not.toBe(result.value.edges[1].id);
    }
  });

  it("文本清洗：控制字符/双向控制符被移除（AC-36）", () => {
    const result = parseCanvasJson(
      canvasJson({
        nodes: [{ id: "a", label: "a\u0000b\u202Ec\u0007", kind: "step", status: "planned" }],
        edges: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodes[0].label).toBe("abc");
  });

  it("恶意 HTML 标签作为纯文本保留（转义由渲染层负责）", () => {
    const result = parseCanvasJson(
      canvasJson({
        nodes: [
          {
            id: "a",
            label: '<img src=x onerror="alert(1)">',
            kind: "step",
            status: "planned",
          },
        ],
        edges: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodes[0].label).toBe('<img src=x onerror="alert(1)">');
  });

  it("direction 缺省：flowchart=TB，dependency=LR", () => {
    const flowchart = niceCanvas({ kind: "flowchart", direction: undefined });
    expect(flowchart.direction).toBe("TB");
    const dependency = niceCanvas({ kind: "dependency", direction: undefined });
    expect(dependency.direction).toBe("LR");
  });
});

describe("提问 schema 与答案校验（AC-09/28）", () => {
  it("四类字段均可解析", () => {
    const raw = questionJson({
      fields: [
        {
          id: "pick",
          kind: "single",
          label: "选一个",
          required: true,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        {
          id: "many",
          kind: "multi",
          label: "多选",
          required: false,
          min: 1,
          max: 2,
          options: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
          ],
        },
        {
          id: "notes",
          kind: "text",
          label: "文本",
          required: false,
          maxLength: 100,
          multiline: true,
        },
        { id: "ok", kind: "confirm", label: "确认", required: true, danger: true },
      ],
    } as Partial<DeerQuestion>);
    const result = parseQuestionJson(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fields.map((field) => field.kind)).toEqual([
        "single",
        "multi",
        "text",
        "confirm",
      ]);
    }
  });

  it("字段 id 重复 / 选项 id 重复 / 单选仅 1 个选项 / multi min>max → E_SCHEMA", () => {
    const dupField = parseQuestionJson(
      questionJson({
        fields: [
          {
            id: "a",
            kind: "single",
            label: "A",
            required: true,
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" },
            ],
          },
          {
            id: "a",
            kind: "single",
            label: "A2",
            required: true,
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" },
            ],
          },
        ],
      } as Partial<DeerQuestion>),
    );
    expect(dupField.ok).toBe(false);

    const dupOption = parseQuestionJson(
      questionJson({
        fields: [
          {
            id: "a",
            kind: "single",
            label: "A",
            required: true,
            options: [
              { id: "x", label: "X" },
              { id: "x", label: "Y" },
            ],
          },
        ],
      } as Partial<DeerQuestion>),
    );
    expect(dupOption.ok).toBe(false);

    const oneOption = parseQuestionJson(
      questionJson({
        fields: [
          {
            id: "a",
            kind: "single",
            label: "A",
            required: true,
            options: [{ id: "x", label: "X" }],
          },
        ],
      } as Partial<DeerQuestion>),
    );
    expect(oneOption.ok).toBe(false);

    const badRange = parseQuestionJson(
      questionJson({
        fields: [
          {
            id: "a",
            kind: "multi",
            label: "A",
            required: false,
            min: 2,
            max: 1,
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" },
            ],
          },
        ],
      } as Partial<DeerQuestion>),
    );
    expect(badRange.ok).toBe(false);
  });

  it("timeoutSec 越界 → E_SCHEMA", () => {
    expect(parseQuestionJson(questionJson({ timeoutSec: 4 } as never)).ok).toBe(false);
    expect(parseQuestionJson(questionJson({ timeoutSec: 3601 } as never)).ok).toBe(false);
  });

  it("答案校验：必填/选项/类型/额外 key/min/max/maxLength", () => {
    const question = {
      protocol: "deer-question" as const,
      version: 1 as const,
      title: "问题",
      fields: [
        {
          id: "pick",
          kind: "single" as const,
          label: "选一个",
          required: true,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        {
          id: "many",
          kind: "multi" as const,
          label: "多选",
          required: true,
          min: 1,
          max: 2,
          options: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
            { id: "z", label: "Z" },
          ],
        },
        {
          id: "text",
          kind: "text" as const,
          label: "文本",
          required: false,
          maxLength: 4,
          multiline: false,
        },
        { id: "ok", kind: "confirm" as const, label: "确认", required: true, danger: false },
      ],
    };

    const missing = validateQuestionAnswers(question, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.map((error) => error.code)).toContain("required");
    }

    const badOption = validateQuestionAnswers(question, {
      pick: "ghost",
      many: ["x"],
      text: "",
      ok: true,
    });
    expect(badOption.ok).toBe(false);
    if (!badOption.ok) {
      expect(badOption.errors.some((error) => error.code === "invalid_option")).toBe(true);
    }

    const badType = validateQuestionAnswers(question, {
      pick: ["a"],
      many: ["x"],
      text: "",
      ok: true,
    });
    expect(badType.ok).toBe(false);

    const extra = validateQuestionAnswers(question, {
      pick: "a",
      many: ["x"],
      text: "",
      ok: true,
      __proto__: "hack",
      extra: 1,
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.errors.some((error) => error.code === "unknown_field")).toBe(true);
    }

    const tooFew = validateQuestionAnswers(question, { pick: "a", many: [], text: "", ok: true });
    expect(tooFew.ok).toBe(false);

    const tooMany = validateQuestionAnswers(question, {
      pick: "a",
      many: ["x", "y", "z"],
      text: "",
      ok: true,
    });
    expect(tooMany.ok).toBe(false);

    const tooLong = validateQuestionAnswers(question, {
      pick: "a",
      many: ["x"],
      text: "12345",
      ok: true,
    });
    expect(tooLong.ok).toBe(false);

    const good = validateQuestionAnswers(question, {
      pick: "b",
      many: ["z", "x"],
      text: "  hi  ",
      ok: false,
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.values.pick).toBe("b");
      // multi 归一化为 options 定义顺序
      expect(good.values.many).toEqual(["x", "z"]);
      expect(good.values.text).toBe("hi");
      expect(good.values.ok).toBe(false);
    }
  });

  it("回答格式化：首行标题、四类字段、多行缩进、空文本", () => {
    const question: DeerQuestion = {
      protocol: "deer-question",
      version: 1,
      title: "确认范围",
      fields: [
        {
          id: "platform",
          kind: "single",
          label: "平台",
          required: true,
          options: [{ id: "desktop", label: "桌面" }],
        },
        {
          id: "features",
          kind: "multi",
          label: "功能",
          required: true,
          options: [
            { id: "flow", label: "流程图" },
            { id: "ask", label: "提问" },
          ],
        },
        { id: "notes", kind: "text", label: "说明", required: false, maxLength: 100, multiline: true },
        { id: "ok", kind: "confirm", label: "开始", required: true, danger: false },
      ],
    };
    const text = formatQuestionAnswer(question, {
      platform: "desktop",
      features: ["flow", "ask"],
      notes: "第一行\n第二行",
      ok: true,
    });
    expect(text.startsWith("[回答表单] 确认范围")).toBe(true);
    expect(text).toContain("- 平台：桌面");
    expect(text).toContain("- 功能：流程图、提问");
    expect(text).toContain("  第一行");
    expect(text).toContain("- 开始：确认");

    const empty = formatQuestionAnswer(question, {
      platform: "desktop",
      features: [],
      notes: "",
      ok: false,
    });
    expect(empty).toContain("- 功能：（空）");
    expect(empty).toContain("- 说明：（空）");
    expect(empty).toContain("- 开始：不确认");
  });
});

describe("流式 / 压缩 / 稳定键 / prompt（AC-31/AC-16）", () => {
  it("流式预览剔除 deer-* fence 及其后内容", () => {
    const content = `前言\n\`\`\`deer-canvas\n{"protocol":`;
    const preview = stripInteractiveForStreaming(content);
    expect(preview.text.trim()).toBe("前言");
    expect(preview.pending).toBe("canvas");
    expect(preview.text).not.toContain("deer-canvas");
  });

  it("流式预览：问题块同样处理", () => {
    const preview = stripInteractiveForStreaming("问题：\n```deer-question\n{");
    expect(preview.text.trim()).toBe("问题：");
    expect(preview.pending).toBe("question");
  });

  it("流式预览：纯文本原样返回", () => {
    const preview = stripInteractiveForStreaming("普通文本");
    expect(preview).toEqual({ text: "普通文本", pending: null });
  });

  it("历史压缩：画布/问题替换为摘要，不保留 JSON", () => {
    const content = [
      "下面是流程：",
      fence("deer-canvas", canvasJson()),
      "还有问题：",
      fence("deer-question", questionJson()),
    ].join("\n");
    const compressed = compressInteractiveForModel(content, "msg_9");
    expect(compressed).toContain("下面是流程：");
    expect(compressed).toContain("[画布「实现流程」kind=flowchart 3 节点/2 边 id=msg_9#b0]");
    expect(compressed).toContain("[表单提问「确认范围」1 字段 id=msg_9#b1]");
    expect(compressed).not.toContain('"protocol"');
  });

  it("历史压缩：非法块只保留错误码", () => {
    const compressed = compressInteractiveForModel(
      `\`\`\`deer-canvas\n{not json\n\`\`\``,
      "m",
    );
    expect(compressed).toBe("[画布：数据无效（E_JSON），未渲染]");
  });

  it("chatBlockKey 稳定", () => {
    expect(chatBlockKey("chat_1", 0)).toBe("chat_1#b0");
    expect(chatBlockKey("chat_1", 3)).toBe("chat_1#b3");
  });

  it("questionExpiresAt 计算", () => {
    expect(questionExpiresAt("2026-01-01T00:00:00.000Z", 60)).toBe(
      "2026-01-01T00:01:00.000Z",
    );
    expect(questionExpiresAt("2026-01-01T00:00:00.000Z")).toBeNull();
  });

  it("系统提示常量包含两种协议与关键约束", () => {
    expect(INTERACTIVE_PROMPT_V1).toContain("deer-canvas");
    expect(INTERACTIVE_PROMPT_V1).toContain("deer-question");
    expect(INTERACTIVE_PROMPT_V1).toContain("不要问密码/密钥/令牌");
    expect(INTERACTIVE_PROMPT_V1).toContain("[回答表单]");
  });

  it("sanitizeText：单行折叠空白、多行最多 8 行", () => {
    expect(sanitizeText("  a \t b  ")).toBe("a b");
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    expect(sanitizeText(lines, { multiline: true }).split("\n")).toHaveLength(8);
  });
});
