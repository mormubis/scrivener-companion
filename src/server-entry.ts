/**
 * SEA entry point.
 *
 * When running as a Node.js Single Executable Application, native addons
 * (.node files) and shared libraries (.dylib) are bundled as assets but
 * can't be loaded directly from the binary. They must be extracted to disk
 * and loaded via process.dlopen().
 *
 * This script:
 * 1. Extracts all native assets to a cache directory
 * 2. Sets up module loading hooks so require('better-sqlite3') etc. work
 * 3. Delegates to the bundled server code
 */

import { isSea, getAsset, getAssetKeys } from "node:sea";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Asset extraction
// ---------------------------------------------------------------------------

const NATIVE_EXTENSIONS = new Set([".node", ".dylib", ".so", ".dll"]);

function getCacheDir(): string {
  const keys = getAssetKeys();
  const hash = crypto
    .createHash("sha256")
    .update(keys.sort().join("|"))
    .digest("hex")
    .slice(0, 12);
  const dir = path.join(os.tmpdir(), `writer-memory-sea-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extractNativeAssets(cacheDir: string): Map<string, string> {
  const extracted = new Map<string, string>();
  const keys = getAssetKeys();

  for (const key of keys) {
    const ext = path.extname(key);
    if (!NATIVE_EXTENSIONS.has(ext)) continue;

    const destPath = path.join(cacheDir, path.basename(key));

    if (!fs.existsSync(destPath)) {
      const data = getAsset(key);
      fs.writeFileSync(destPath, new Uint8Array(data as ArrayBuffer));
      if (ext === ".node" || ext === ".dylib" || ext === ".so") {
        fs.chmodSync(destPath, 0o755);
      }
    }

    extracted.set(key, destPath);
  }

  return extracted;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!isSea()) {
  import("./cli.js");
} else {
  const cacheDir = getCacheDir();
  const assets = extractNativeAssets(cacheDir);

  // Create shim for better-sqlite3
  const betterSqlitePath = assets.get("better_sqlite3.node");
  if (betterSqlitePath) {
    const shimDir = path.join(cacheDir, "better-sqlite3");
    fs.mkdirSync(shimDir, { recursive: true });
    const releaseDir = path.join(shimDir, "build", "Release");
    fs.mkdirSync(releaseDir, { recursive: true });
    if (!fs.existsSync(path.join(releaseDir, "better_sqlite3.node"))) {
      fs.copyFileSync(
        betterSqlitePath,
        path.join(releaseDir, "better_sqlite3.node"),
      );
    }
  }

  // Set SQLITE_VEC_PATH so the bundled sqlite-vec shim can find vec0.dylib
  const vec0Path = assets.get("vec0.dylib");
  if (vec0Path) {
    process.env.SQLITE_VEC_PATH = vec0Path;
  }

  // Set onnxruntime binding path
  const onnxBindingPath = assets.get("onnxruntime_binding.node");
  if (onnxBindingPath) {
    process.env.ONNXRUNTIME_NODE_BINDING_PATH = onnxBindingPath;
  }
  const onnxLibPath = assets.get("libonnxruntime.dylib");
  if (onnxLibPath) {
    process.env.ONNXRUNTIME_LIB_PATH = onnxLibPath;
  }

  // Load and run the bundled CLI
  const serverAsset = getAsset("cli.js", "utf8");
  const serverPath = path.join(cacheDir, "cli.js");
  if (!fs.existsSync(serverPath)) {
    fs.writeFileSync(serverPath, serverAsset);
  }

  const require = createRequire(serverPath);
  require(serverPath);
}
