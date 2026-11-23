import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  isReactCompilerBuild,
  reactCompilerBabelPlugins,
} from "./src/shell/reactCompilerBoundary.js";

export default defineConfig(({ command }) => {
  const compilerEnabled = isReactCompilerBuild(command);
  return {
  base: "./",
  plugins: [
    react(
      compilerEnabled
        ? {
            babel: {
              // RC1-0: one allowlisted renderer component only; tests/dev never load this.
              plugins: [...reactCompilerBabelPlugins()],
            },
          }
        : {},
    ),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          if (!path.includes("/node_modules/")) return undefined;
          if (
            path.includes("/react-markdown/") ||
            path.includes("/remark-") ||
            path.includes("/rehype-") ||
            path.includes("/unified/") ||
            path.includes("/micromark") ||
            path.includes("/mdast-") ||
            path.includes("/hast-") ||
            path.includes("/property-information/") ||
            path.includes("/space-separated-tokens/") ||
            path.includes("/comma-separated-tokens/") ||
            path.includes("/vfile/") ||
            path.includes("/unist-") ||
            path.includes("/ccount/") ||
            path.includes("/character-entities/") ||
            path.includes("/decode-named-character-reference/") ||
            path.includes("/devlop/") ||
            path.includes("/html-url-attributes/") ||
            path.includes("/longest-streak/") ||
            path.includes("/markdown-table/") ||
            path.includes("/trim-lines/") ||
            path.includes("/zwitch/")
          ) {
            return "vendor-markdown";
          }
          if (
            path.includes("/react/") ||
            path.includes("/react-dom/") ||
            path.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (path.includes("/zod/")) return "vendor-zod";
          return undefined;
        },
      },
    },
  },
  };
});
