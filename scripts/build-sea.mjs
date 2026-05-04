import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ARCH = process.arch; // arm64 or x64
const PLATFORM = process.platform; // darwin
const OUTPUT_NAME = `writer-memory-server-${PLATFORM}-${ARCH}`;
const DIST_DIR = "dist";

// Step 1: Bundle server code
console.log("Bundling server code...");
execSync("node scripts/build-server.mjs", { stdio: "inherit" });

// Step 2: Bundle SEA entry point
console.log("Bundling SEA entry point...");
execSync(
  [
    "npx esbuild src/server-entry.ts",
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=cjs",
    `--outfile=${DIST_DIR}/server-entry.js`,
    "--external:node:sea",
    "--external:node:module",
  ].join(" "),
  { stdio: "inherit" },
);

// Step 3: Locate native assets
console.log("Collecting native assets...");
const assets = {};

// server.js bundle
assets["server.js"] = path.resolve(DIST_DIR, "server.js");

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

// onnxruntime-node — check both possible locations (direct dependency and nested under @huggingface/transformers)
const onnxBaseDirect = `node_modules/onnxruntime-node/bin/napi-v6/${PLATFORM}/${ARCH}`;
const onnxBaseNested = `node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6/${PLATFORM}/${ARCH}`;
const onnxBase = fs.existsSync(path.resolve(onnxBaseDirect)) ? onnxBaseDirect : onnxBaseNested;

const onnxBinding = path.resolve(onnxBase, "onnxruntime_binding.node");
if (fs.existsSync(onnxBinding)) {
  assets["onnxruntime_binding.node"] = onnxBinding;
} else {
  throw new Error(`onnxruntime_binding.node not found at ${onnxBinding}`);
}

// onnxruntime shared lib (macOS has libonnxruntime.*.dylib)
const onnxLibs = fs
  .readdirSync(path.resolve(onnxBase))
  .filter((f) => f.startsWith("libonnxruntime") && f.endsWith(".dylib"));
for (const lib of onnxLibs) {
  assets["libonnxruntime.dylib"] = path.resolve(onnxBase, lib);
}

console.log("Assets:", Object.keys(assets));

// Step 4: Write SEA config
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

// Step 5: Build SEA
console.log("Building SEA binary...");
execSync(`node --build-sea ${configPath}`, { stdio: "inherit" });

// Step 6: Sign (macOS)
if (PLATFORM === "darwin") {
  console.log("Signing binary...");
  const outputPath = path.resolve(DIST_DIR, OUTPUT_NAME);
  execSync(`codesign --sign - "${outputPath}"`, { stdio: "inherit" });
}

// Step 7: Compute sha256
const outputPath = path.resolve(DIST_DIR, OUTPUT_NAME);
const hash = execSync(`shasum -a 256 "${outputPath}"`).toString().split(" ")[0];
fs.writeFileSync(`${outputPath}.sha256`, hash);
console.log(`\nBuild complete: ${outputPath}`);
console.log(`SHA256: ${hash}`);
