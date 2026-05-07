import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync("dist", { recursive: true });

// Plugin to handle native modules that can't be bundled
const nativeModulesPlugin = {
  name: "native-modules",
  setup(build) {
    // Replace better-sqlite3's bindings() call with a direct require
    // of the .node file from a known path (set by server-entry.ts for SEA)
    build.onResolve({ filter: /^bindings$/ }, () => {
      return { path: "bindings", namespace: "bindings-shim" };
    });
    build.onLoad({ filter: /.*/, namespace: "bindings-shim" }, () => {
      return {
        contents: `
          const path = require('path');
          module.exports = function(name) {
            // In SEA context, the .node file is extracted next to cli.js
            // In dev context, use the normal node_modules path
            const candidates = [
              path.join(path.dirname(process.argv[1] || __filename), name),
              path.join(__dirname, '..', 'build', 'Release', name),
              path.join(process.cwd(), 'node_modules', 'better-sqlite3', 'build', 'Release', name),
            ];
            for (const candidate of candidates) {
              try { return require(candidate); } catch {}
            }
            throw new Error('Could not find native addon: ' + name);
          };
        `,
        loader: "js",
      };
    });

    // Replace sqlite-vec's getLoadablePath with one that checks env var first
    build.onResolve({ filter: /^sqlite-vec$/ }, () => {
      return { path: "sqlite-vec", namespace: "sqlite-vec-shim" };
    });
    build.onLoad({ filter: /.*/, namespace: "sqlite-vec-shim" }, () => {
      return {
        contents: `
          const { arch, platform } = require('node:process');
          const path = require('path');
          function getLoadablePath() {
            if (process.env.SQLITE_VEC_PATH) return process.env.SQLITE_VEC_PATH;
            const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so';
            const os = platform === 'win32' ? 'windows' : platform;
            const pkg = 'sqlite-vec-' + os + '-' + arch;
            return require.resolve(pkg + '/vec0.' + ext);
          }
          function load(db) {
            const p = getLoadablePath();
            // better-sqlite3 loadExtension auto-appends the platform suffix
            db.loadExtension(p.replace(/\\.(dylib|so|dll)$/, ''));
          }
          module.exports = { load, getLoadablePath };
        `,
        loader: "js",
      };
    });

    // Stub .node files — they're loaded at runtime, not at bundle time
    build.onLoad({ filter: /\.node$/ }, () => {
      return { contents: "", loader: "js" };
    });
  },
};

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/cli.js",
  plugins: [nativeModulesPlugin],
  external: [
    // onnxruntime-node stays external — too complex to bundle, handled via SEA shim
    "onnxruntime-node",
  ],
  alias: {
    "sharp": path.resolve("scripts/empty-module.cjs"),
  },
});

console.log("CLI bundle written to dist/cli.js");
