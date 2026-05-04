import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/server.js",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "onnxruntime-node",
    "@huggingface/transformers",
  ],
});

console.log("Server bundle written to dist/server.js");
