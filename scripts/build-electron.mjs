import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist-electron");

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(outdir, "main.cjs"),
});

await build({
  ...common,
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(outdir, "preload.cjs"),
});
