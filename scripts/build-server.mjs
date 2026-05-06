import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/cli.js",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "onnxruntime-node",
    "@huggingface/transformers",
  ],
});

console.log("CLI bundle written to dist/cli.js");
