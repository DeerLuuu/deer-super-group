import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "./Markdown";

describe("Markdown", () => {
  it("renders headings, lists, code fences and GFM tables", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={[
          "# Title",
          "",
          "- one",
          "- two",
          "",
          "```ts",
          "const x = 1;",
          "```",
          "",
          "| a | b |",
          "| --- | --- |",
          "| 1 | 2 |",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code");
  });

  it("drops raw HTML instead of injecting it", () => {
    const html = renderToStaticMarkup(
      <Markdown content={'<img src="x" onerror="alert(1)">'} />,
    );
    expect(html).not.toContain("<img");
  });
});
