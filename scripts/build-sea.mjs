import { execSync } from "node:child_process";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const ARCH = process.arch;
const PLATFORM = process.platform;
const OUTPUT_NAME = `scrivener-companion-${PLATFORM}-${ARCH}`;
const DIST_DIR = "dist";

// Step 1: Bundle CLI code
console.log("Bundling CLI code...");
execSync("node scripts/build-server.mjs", { stdio: "inherit" });

// Step 2: Bundle SEA entry point
console.log("Bundling SEA entry point...");
await build({
  entryPoints: ["src/server-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: `${DIST_DIR}/server-entry.js`,
  external: ["node:sea", "node:module", "./cli.js"],
});

// Step 3: Build onnxruntime-node shim bundle
// Bundles onnxruntime-node + onnxruntime-common into a single CJS file.
// Uses an esbuild plugin to replace the native binding loader with one
// that reads the path from an env var set by server-entry.ts.
console.log("Bundling onnxruntime-node shim...");

const onnxBindingPlugin = {
  name: "onnx-binding-shim",
  setup(build) {
    // Intercept the binding.js that loads the native .node file
    build.onResolve({ filter: /\.\/binding$/ }, (args) => {
      if (args.importer.includes("onnxruntime-node")) {
        return { path: args.path, namespace: "onnx-binding-shim" };
      }
    });
    build.onLoad({ filter: /.*/, namespace: "onnx-binding-shim" }, () => {
      return {
        contents: `
          'use strict';
          const onnxCommon = require('onnxruntime-common');
          const bindingPath = process.env.ONNXRUNTIME_NODE_BINDING_PATH;
          if (!bindingPath) throw new Error('ONNXRUNTIME_NODE_BINDING_PATH not set');
          const binding = require(bindingPath);
          let ortInitialized = false;
          exports.binding = binding;
          exports.initOrt = () => {
            if (!ortInitialized) {
              ortInitialized = true;
              binding.initOrtOnce(2, onnxCommon.Tensor);
            }
          };
          exports.listSupportedBackends = () => [{ name: 'cpu', bundle: false }];
        `,
        resolveDir: process.cwd(),
        loader: "js",
      };
    });
    // Stub .node files
    build.onResolve({ filter: /\.node$/ }, () => {
      return { path: "stub.node", namespace: "node-stub" };
    });
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => {
      return { contents: "module.exports = {}", loader: "js" };
    });
  },
};

await build({
  entryPoints: ["node_modules/onnxruntime-node/dist/index.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: `${DIST_DIR}/onnxruntime-node-shim.js`,
  plugins: [onnxBindingPlugin],
});

// Step 4: Locate native assets
console.log("Collecting native assets...");
const assets = {};

// cli.js bundle
assets["cli.js"] = path.resolve(DIST_DIR, "cli.js");

// onnxruntime-node shim
assets["onnxruntime-node-shim.js"] = path.resolve(DIST_DIR, "onnxruntime-node-shim.js");

// better-sqlite3
const betterSqliteNode = path.resolve(
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
);
if (fs.existsSync(betterSqliteNode)) {
  assets["better_sqlite3.node"] = betterSqliteNode;
} else {
  throw new Error("better_sqlite3.node not found");
}

// sqlite-vec
const sqliteVecPkg = `sqlite-vec-${PLATFORM === "win32" ? "windows" : PLATFORM}-${ARCH}`;
const vecExt = PLATFORM === "darwin" ? "dylib" : PLATFORM === "win32" ? "dll" : "so";
const vec0Path = path.resolve(`node_modules/${sqliteVecPkg}/vec0.${vecExt}`);
if (fs.existsSync(vec0Path)) {
  assets[`vec0.${vecExt}`] = vec0Path;
} else {
  throw new Error(`sqlite-vec native lib not found at ${vec0Path}`);
}

// onnxruntime-node native bindings
const onnxBaseDirect = `node_modules/onnxruntime-node/bin/napi-v6/${PLATFORM}/${ARCH}`;
const onnxBaseNested = `node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6/${PLATFORM}/${ARCH}`;
const onnxBase = fs.existsSync(path.resolve(onnxBaseDirect)) ? onnxBaseDirect : onnxBaseNested;

const onnxBinding = path.resolve(onnxBase, "onnxruntime_binding.node");
if (fs.existsSync(onnxBinding)) {
  assets["onnxruntime_binding.node"] = onnxBinding;
} else {
  throw new Error(`onnxruntime_binding.node not found at ${onnxBinding}`);
}

const onnxLibs = fs
  .readdirSync(path.resolve(onnxBase))
  .filter((f) => f.startsWith("libonnxruntime") && f.endsWith(".dylib"));
for (const lib of onnxLibs) {
  assets[lib] = path.resolve(onnxBase, lib);
}

console.log("Assets:", Object.keys(assets));

// Step 5: Write SEA config
const seaConfig = {
  main: path.resolve(DIST_DIR, "server-entry.js"),
  output: path.resolve(DIST_DIR, OUTPUT_NAME),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
};

const configPath = path.resolve(DIST_DIR, "sea-config.json");
fs.mkdirSync(DIST_DIR, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
console.log("SEA config written to", configPath);

// Step 6: Build SEA
console.log("Building SEA binary...");
execSync(`node --build-sea ${configPath}`, { stdio: "inherit" });

// Step 7: Sign (macOS)
if (PLATFORM === "darwin") {
  console.log("Signing binary...");
  const outputPath = path.resolve(DIST_DIR, OUTPUT_NAME);
  execSync(`codesign --sign - "${outputPath}"`, { stdio: "inherit" });
}

// Step 8: Compute sha256
const outputPath = path.resolve(DIST_DIR, OUTPUT_NAME);
const hash = execSync(`shasum -a 256 "${outputPath}"`).toString().split(" ")[0];
fs.writeFileSync(`${outputPath}.sha256`, hash);
console.log(`\nBuild complete: ${outputPath}`);
console.log(`SHA256: ${hash}`);
