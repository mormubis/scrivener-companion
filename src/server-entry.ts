/**
 * SEA entry point.
 *
 * When running as a Node.js Single Executable Application, native addons
 * (.node files) and shared libraries (.dylib) are bundled as assets but
 * can't be loaded directly from the binary. They must be extracted to disk.
 *
 * This script:
 * 1. Extracts all native assets to a cache directory
 * 2. Sets up the onnxruntime-node shim under node_modules/
 * 3. Delegates to the bundled CLI code
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
  // Hash asset sizes so cache invalidates on rebuild
  const h = crypto.createHash("sha256");
  for (const key of getAssetKeys().sort()) {
    h.update(key);
    const raw = getAsset(key);
    h.update(String(raw instanceof ArrayBuffer ? raw.byteLength : (raw as string).length));
  }
  const hash = h.digest("hex").slice(0, 12);
  const dir = path.join(os.tmpdir(), `scrivener-companion-sea-${hash}`);
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

  // sqlite-vec: set env var so the bundled shim can find vec0
  const vec0Path = assets.get("vec0.dylib");
  if (vec0Path) {
    process.env.SQLITE_VEC_PATH = vec0Path;
  }

  // onnxruntime: set env vars for native bindings
  const onnxBindingPath = assets.get("onnxruntime_binding.node");
  if (onnxBindingPath) {
    process.env.ONNXRUNTIME_NODE_BINDING_PATH = onnxBindingPath;
  }
  for (const [key, val] of assets) {
    if (key.startsWith("libonnxruntime") && key.endsWith(".dylib")) {
      process.env.ONNXRUNTIME_LIB_PATH = val;
      break;
    }
  }

  // Create onnxruntime-node shim under node_modules/
  const nodeModulesDir = path.join(cacheDir, "node_modules");
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  const onnxShimDir = path.join(nodeModulesDir, "onnxruntime-node");
  fs.mkdirSync(onnxShimDir, { recursive: true });
  const onnxShimIndex = path.join(onnxShimDir, "index.js");
  if (!fs.existsSync(onnxShimIndex)) {
    const shimContent = getAsset("onnxruntime-node-shim.js", "utf8");
    fs.writeFileSync(onnxShimIndex, shimContent);
  }

  // Load and run the bundled CLI
  const cliAsset = getAsset("cli.js", "utf8");
  const cliPath = path.join(cacheDir, "cli.js");
  if (!fs.existsSync(cliPath)) {
    fs.writeFileSync(cliPath, cliAsset);
  }

  const require = createRequire(cliPath);
  require(cliPath);
}
