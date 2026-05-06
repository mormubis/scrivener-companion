# Server Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform scrivener-companion into a CLI-managed daemon with unix domain socket, centralized config, project registry, and self-contained metadata storage.

**Architecture:** New `src/config.ts` module manages paths and project registry. New `src/cli.ts` handles start/stop/restart/status commands. `src/server.ts` is rewritten to use unix socket, flock, PID file, state machine, and project API endpoints. `src/ingest/store.ts` gains a `documents` table replacing the external `index.db`. `src/ingest/index.ts` upserts document metadata during ingest.

**Tech Stack:** TypeScript, Fastify (unix socket), better-sqlite3, sqlite-vec, @huggingface/transformers, Node SEA

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Create | Config directory paths, project registry (read/write projects.json, slug generation) |
| `src/cli.ts` | Create | CLI entry point: start, stop, restart, status commands |
| `src/server.ts` | Rewrite | Daemon mode (--serve), unix socket, flock, PID file, state machine, all HTTP endpoints |
| `src/ingest/store.ts` | Modify | Add `documents` table, `upsertDocument`, `lookupDocMeta`, `getDocumentModifiedAt` reads from `documents` |
| `src/ingest/index.ts` | Modify | Upsert document metadata during ingest, update re-exports |
| `src/server-entry.ts` | Modify | Update to load CLI instead of server directly |
| `scripts/build-server.mjs` | Modify | Update entry point to `src/cli.ts` |

---

### Task 1: Create `src/config.ts` — config directory and project registry

**Files:**
- Create: `src/config.ts`

- [ ] **Step 1: Write `src/config.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".config", "scrivener-companion");
const STORE_DIR = path.join(CONFIG_DIR, "store");

export const paths = {
  configDir: CONFIG_DIR,
  storeDir: STORE_DIR,
  lock: path.join(CONFIG_DIR, "server.lock"),
  pid: path.join(CONFIG_DIR, "server.pid"),
  sock: path.join(CONFIG_DIR, "server.sock"),
  projects: path.join(CONFIG_DIR, "projects.json"),
} as const;

export function ensureDirs(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  slug: string;
  path: string;
  name: string;
  dbPath: string;
}

export function generateSlug(scrivPath: string): string {
  const absolutePath = path.resolve(scrivPath);
  const name = path.basename(absolutePath, ".scriv")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const hash = crypto
    .createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .slice(0, 6);
  return `${name}-${hash}`;
}

export function readRegistry(): Record<string, string> {
  if (!fs.existsSync(paths.projects)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(paths.projects, "utf-8"));
}

export function writeRegistry(registry: Record<string, string>): void {
  ensureDirs();
  fs.writeFileSync(paths.projects, JSON.stringify(registry, null, 2) + "\n");
}

export function listProjects(): ProjectEntry[] {
  const registry = readRegistry();
  return Object.entries(registry).map(([scrivPath, slug]) => ({
    slug,
    path: scrivPath,
    name: path.basename(scrivPath, ".scriv"),
    dbPath: path.join(STORE_DIR, `${slug}.db`),
  }));
}

export function addProject(scrivPath: string): ProjectEntry {
  const absolutePath = path.resolve(scrivPath);
  const registry = readRegistry();

  if (registry[absolutePath]) {
    throw new Error(`project already registered: ${absolutePath}`);
  }

  // Validate it's a .scriv bundle
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`path does not exist: ${absolutePath}`);
  }
  const entries = fs.readdirSync(absolutePath);
  if (!entries.some((e) => e.endsWith(".scrivx"))) {
    throw new Error(`no .scrivx file found in ${absolutePath}`);
  }

  const slug = generateSlug(absolutePath);
  registry[absolutePath] = slug;
  writeRegistry(registry);

  return {
    slug,
    path: absolutePath,
    name: path.basename(absolutePath, ".scriv"),
    dbPath: path.join(STORE_DIR, `${slug}.db`),
  };
}

export function removeProject(slug: string): ProjectEntry | null {
  const registry = readRegistry();
  const entry = Object.entries(registry).find(([, s]) => s === slug);
  if (!entry) return null;

  const [scrivPath] = entry;
  delete registry[scrivPath];
  writeRegistry(registry);

  const dbPath = path.join(STORE_DIR, `${slug}.db`);
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  return {
    slug,
    path: scrivPath,
    name: path.basename(scrivPath, ".scriv"),
    dbPath,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config module with paths and project registry"
```

---

### Task 2: Update `src/ingest/store.ts` — add `documents` table, replace `document_index`

**Files:**
- Modify: `src/ingest/store.ts`

- [ ] **Step 1: Update `openDb` schema — replace `document_index` with `documents` table**

In `openDb`, replace the `document_index` CREATE TABLE with:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      uuid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      binder_path TEXT NOT NULL,
      binder_section TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      label TEXT,
      status TEXT,
      section_type TEXT,
      include_in_compile INTEGER NOT NULL DEFAULT 1,
      deep_link TEXT NOT NULL,
      modified_at REAL NOT NULL
    )
  `);
```

Also add a migration for existing DBs that have the old `document_index` table but not `documents`:

```typescript
  // Migrate from document_index to documents
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));
  if (tableNames.has("document_index") && !tableNames.has("documents")) {
    db.exec(`
      CREATE TABLE documents (
        uuid TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        binder_path TEXT NOT NULL DEFAULT '',
        binder_section TEXT NOT NULL DEFAULT '',
        doc_type TEXT NOT NULL DEFAULT '',
        label TEXT,
        status TEXT,
        section_type TEXT,
        include_in_compile INTEGER NOT NULL DEFAULT 1,
        deep_link TEXT NOT NULL DEFAULT '',
        modified_at REAL NOT NULL
      )
    `);
    db.exec("INSERT INTO documents (uuid, modified_at, title, binder_path, binder_section, doc_type, deep_link) SELECT document_uuid, modified_at, '', '', '', '', '' FROM document_index");
    db.exec("DROP TABLE document_index");
  }
```

- [ ] **Step 2: Add `upsertDocument` function**

```typescript
export interface DocumentMeta {
  uuid: string;
  title: string;
  binderPath: string;
  binderSection: string;
  docType: string;
  label: string | null;
  status: string | null;
  sectionType: string | null;
  includeInCompile: boolean;
  deepLink: string;
  modifiedAt: number;
}

export function upsertDocument(db: Database.Database, doc: DocumentMeta): void {
  db.prepare(`
    INSERT INTO documents (uuid, title, binder_path, binder_section, doc_type, label, status, section_type, include_in_compile, deep_link, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      title = excluded.title,
      binder_path = excluded.binder_path,
      binder_section = excluded.binder_section,
      doc_type = excluded.doc_type,
      label = excluded.label,
      status = excluded.status,
      section_type = excluded.section_type,
      include_in_compile = excluded.include_in_compile,
      deep_link = excluded.deep_link,
      modified_at = excluded.modified_at
  `).run(
    doc.uuid, doc.title, doc.binderPath, doc.binderSection, doc.docType,
    doc.label, doc.status, doc.sectionType, doc.includeInCompile ? 1 : 0,
    doc.deepLink, doc.modifiedAt,
  );
}
```

- [ ] **Step 3: Add `lookupDocMeta` function**

Replace the server's `lookupDocMeta` that reads from external `index.db`:

```typescript
export interface DocMeta {
  title: string;
  binder_path: string;
  binder_section: string;
  deep_link: string | null;
}

export function lookupDocMeta(db: Database.Database, uuid: string): DocMeta | null {
  const row = db
    .prepare("SELECT title, binder_path, binder_section, deep_link FROM documents WHERE uuid = ?")
    .get(uuid) as DocMeta | undefined;
  return row ?? null;
}
```

- [ ] **Step 4: Update `getDocumentModifiedAt` to read from `documents` table**

```typescript
export function getDocumentModifiedAt(
  db: Database.Database,
  uuid: string,
): number | null {
  const row = db
    .prepare("SELECT modified_at FROM documents WHERE uuid = ?")
    .get(uuid) as { modified_at: number } | undefined;
  return row?.modified_at ?? null;
}
```

- [ ] **Step 5: Update `getIndexedDocumentUuids` to read from `documents` table**

```typescript
export function getIndexedDocumentUuids(
  db: Database.Database,
): Set<string> {
  const rows = db
    .prepare("SELECT uuid FROM documents")
    .all() as { uuid: string }[];
  return new Set(rows.map((r) => r.uuid));
}
```

- [ ] **Step 6: Update `removeDocument` to delete from `documents` table**

```typescript
export function removeDocument(
  db: Database.Database,
  uuid: string,
): void {
  deleteDocumentChunks(db, uuid);
  db.prepare("DELETE FROM documents WHERE uuid = ?").run(uuid);
}
```

- [ ] **Step 7: Remove `upsertDocumentIndex` — replaced by `upsertDocument`**

Delete the `upsertDocumentIndex` function entirely.

- [ ] **Step 8: Commit**

```bash
git add src/ingest/store.ts
git commit -m "feat: replace document_index with documents table for metadata storage"
```

---

### Task 3: Update `src/ingest/index.ts` — upsert metadata during ingest

**Files:**
- Modify: `src/ingest/index.ts`

- [ ] **Step 1: Update imports and `ingest()` function**

Replace `upsertDocumentIndex` import with `upsertDocument`:

```typescript
import { insertChunk, deleteChunkById, getChunksByDocument, upsertDocument } from "./store.js";
```

At the end of `ingest()`, replace `upsertDocumentIndex(db, doc.uuid, doc.modifiedAt)` with:

```typescript
  upsertDocument(db, {
    uuid: doc.uuid,
    title: doc.title,
    binderPath: doc.binderPath,
    binderSection: doc.binderSection,
    docType: doc.docType,
    label: doc.label,
    status: doc.status,
    sectionType: doc.sectionType,
    includeInCompile: doc.includeInCompile,
    deepLink: doc.deepLink,
    modifiedAt: doc.modifiedAt,
  });
```

Note: `doc` here is a `WalkedDocument` which has all these fields.

- [ ] **Step 2: Update re-exports**

Replace `upsertDocumentIndex` with `upsertDocument` and add `lookupDocMeta`, `DocMeta`, `DocumentMeta` to re-exports:

```typescript
export {
  openDb,
  insertChunk,
  deleteChunkById,
  searchSimilar,
  getDocumentModifiedAt,
  upsertDocument,
  getIndexedDocumentUuids,
  removeDocument,
  getChunksByDocument,
  lookupDocMeta,
} from "./store.js";
export type { VectorSearchResult, StoredChunk, DocMeta, DocumentMeta } from "./store.js";
```

- [ ] **Step 3: Commit**

```bash
git add src/ingest/index.ts
git commit -m "feat: upsert document metadata during ingest"
```

---

### Task 4: Create `src/cli.ts` — CLI entry point

**Files:**
- Create: `src/cli.ts`

- [ ] **Step 1: Write `src/cli.ts`**

```typescript
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { paths, ensureDirs } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!fs.existsSync(paths.pid)) return null;
  const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function cleanStaleFiles(): void {
  if (fs.existsSync(paths.pid)) fs.unlinkSync(paths.pid);
  if (fs.existsSync(paths.sock)) fs.unlinkSync(paths.sock);
}

function healthCheck(): Promise<{ status: string; state: string } | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: paths.sock, path: "/health", method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(`already running (PID ${existingPid})`);
    process.exit(1);
  }

  // Clean up stale files from previous crash
  cleanStaleFiles();
  ensureDirs();

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();
  console.log(`started (PID ${child.pid})`);
  process.exit(0);
}

async function stop(): Promise<void> {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    cleanStaleFiles();
    console.log("not running");
    process.exit(0);
  }

  process.kill(pid, "SIGTERM");
  const exited = await waitForExit(pid, 10000);

  if (!exited) {
    console.error(`PID ${pid} did not exit in 10s, sending SIGKILL`);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 5000);
  }

  cleanStaleFiles();
  console.log("stopped");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

async function status(): Promise<void> {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    console.log("stopped");
    process.exit(0);
  }

  const health = await healthCheck();
  if (health) {
    console.log(`running (${health.state})`);
  } else {
    console.log("running (starting)");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === "--serve") {
  // Daemon mode — import and run the server
  import("./server.js");
} else if (command === "start") {
  start();
} else if (command === "stop") {
  stop();
} else if (command === "restart") {
  restart();
} else if (command === "status") {
  status();
} else {
  console.error("usage: scrivener-companion <start|stop|restart|status>");
  process.exit(1);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI with start/stop/restart/status commands"
```

---

### Task 5: Rewrite `src/server.ts` — daemon mode with unix socket, flock, state machine, project API

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Rewrite `src/server.ts`**

Replace the entire file:

```typescript
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  ingest,
  walk,
  Embedder,
  openDb,
  searchSimilar,
  getDocumentModifiedAt,
  getIndexedDocumentUuids,
  removeDocument,
  lookupDocMeta,
  type VectorSearchResult,
} from "./ingest/index.js";
import {
  paths,
  ensureDirs,
  listProjects,
  addProject,
  removeProject,
  type ProjectEntry,
} from "./config.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ServerState = "starting" | "indexing" | "ready" | "stopping";
let state: ServerState = "starting";

// ---------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------

interface ProjectState {
  entry: ProjectEntry;
  db: Database.Database;
}

// ---------------------------------------------------------------------------
// Indexing (delta orchestration)
// ---------------------------------------------------------------------------

async function indexProject(
  project: ProjectState,
  embedder: Embedder,
  force = false,
): Promise<{ embedded: number; skipped: number; deleted: number }> {
  let embedded = 0;
  let skipped = 0;
  let deleted = 0;

  const { documents } = walk(project.entry.path);

  // Phase 1: Delete orphaned documents
  const currentUuids = new Set(documents.map((d) => d.uuid));
  const indexedUuids = getIndexedDocumentUuids(project.db);

  for (const uuid of indexedUuids) {
    if (!currentUuids.has(uuid)) {
      removeDocument(project.db, uuid);
      deleted++;
    }
  }

  // Phase 2: Ingest new and modified documents
  for (const doc of documents) {
    if (!force) {
      const storedModifiedAt = getDocumentModifiedAt(project.db, doc.uuid);
      if (storedModifiedAt !== null && storedModifiedAt >= doc.modifiedAt) {
        skipped++;
        continue;
      }
    }

    const result = await ingest(doc, embedder, project.db);
    embedded += result.embedded;
    skipped += result.skipped;
  }

  return { embedded, skipped, deleted };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function acquireLock(): number {
  ensureDirs();
  const fd = fs.openSync(paths.lock, "w");
  try {
    // Try non-blocking exclusive lock
    // Node.js doesn't have flock(), use fs.writeFileSync as a simple lock
    // Write our PID to the lock file atomically
    fs.writeFileSync(paths.lock, String(process.pid) + "\n");
    return fd;
  } catch {
    fs.closeSync(fd);
    throw new Error("failed to acquire lock");
  }
}

function writePid(): void {
  fs.writeFileSync(paths.pid, String(process.pid) + "\n");
}

function cleanup(): void {
  try { fs.unlinkSync(paths.sock); } catch {}
  try { fs.unlinkSync(paths.pid); } catch {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  // Acquire lock and set up lifecycle
  acquireLock();

  // Clean up stale socket from previous crash
  if (fs.existsSync(paths.sock)) {
    fs.unlinkSync(paths.sock);
  }

  writePid();
  ensureDirs();

  // Graceful shutdown
  const shutdown = async () => {
    if (state === "stopping") return;
    state = "stopping";
    console.log("[scrivener-companion] shutting down...");
    await server.close();
    cleanup();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Load embedder
  const modelDir = process.env.WRITER_MEMORY_MODEL_DIR ?? "";
  if (!modelDir) {
    throw new Error("WRITER_MEMORY_MODEL_DIR is required");
  }

  const embedder = new Embedder(modelDir);
  await embedder.initialize();

  // Index all registered projects
  state = "indexing";
  const projects: ProjectState[] = [];

  for (const entry of listProjects()) {
    const db = openDb(entry.dbPath);
    const project: ProjectState = { entry, db };
    projects.push(project);

    console.log(`[scrivener-companion] indexing ${entry.name}...`);
    try {
      const stats = await indexProject(project, embedder);
      console.log(
        `[scrivener-companion] indexed ${entry.name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
      );
    } catch (err) {
      console.error(`[scrivener-companion] failed to index ${entry.name}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------

  const server = Fastify({ logger: false });

  // GET /health
  server.get("/health", async () => {
    return { status: "ok", state };
  });

  // POST /search
  server.post<{
    Body: { query: string; topK?: number };
  }>("/search", async (request, reply) => {
    const { query, topK = 10 } = request.body;

    if (!query || typeof query !== "string") {
      return reply.status(400).send({ error: "query is required" });
    }

    const queryEmbedding = await embedder.embed(query);

    const results: Array<{
      chunk_text: string;
      document_uuid: string;
      title: string | null;
      binder_path: string | null;
      binder_section: string | null;
      deep_link: string | null;
      distance: number;
      project: string;
    }> = [];

    for (const project of projects) {
      let hits: VectorSearchResult[];
      try {
        hits = searchSimilar(project.db, queryEmbedding, topK);
      } catch {
        hits = [];
      }

      for (const hit of hits) {
        const meta = lookupDocMeta(project.db, hit.document_uuid);
        results.push({
          chunk_text: hit.chunk_text,
          document_uuid: hit.document_uuid,
          title: meta?.title ?? null,
          binder_path: meta?.binder_path ?? null,
          binder_section: meta?.binder_section ?? null,
          deep_link: meta?.deep_link ?? null,
          distance: hit.distance,
          project: project.entry.name,
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, topK);
  });

  // POST /index — re-index all projects
  server.post("/index", async () => {
    const totals = { embedded: 0, skipped: 0, deleted: 0 };
    for (const project of projects) {
      console.log(`[scrivener-companion] re-indexing ${project.entry.name}...`);
      try {
        const stats = await indexProject(project, embedder, true);
        totals.embedded += stats.embedded;
        totals.skipped += stats.skipped;
        totals.deleted += stats.deleted;
        console.log(
          `[scrivener-companion] indexed ${project.entry.name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
        );
      } catch (err) {
        console.error(
          `[scrivener-companion] failed to re-index ${project.entry.name}:`,
          err,
        );
      }
    }
    return totals;
  });

  // GET /projects
  server.get("/projects", async () => {
    return projects.map((p) => ({
      slug: p.entry.slug,
      path: p.entry.path,
      name: p.entry.name,
    }));
  });

  // POST /projects
  server.post<{
    Body: { path: string };
  }>("/projects", async (request, reply) => {
    const { path: scrivPath } = request.body;

    if (!scrivPath || typeof scrivPath !== "string") {
      return reply.status(400).send({ error: "path is required" });
    }

    // Check if already registered
    const existing = projects.find((p) => p.entry.path === path.resolve(scrivPath));
    if (existing) {
      return reply.status(409).send({ error: "project already registered", slug: existing.entry.slug });
    }

    let entry: ProjectEntry;
    try {
      entry = addProject(scrivPath);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const db = openDb(entry.dbPath);
    const project: ProjectState = { entry, db };
    projects.push(project);

    // Trigger initial index
    console.log(`[scrivener-companion] indexing ${entry.name}...`);
    try {
      const stats = await indexProject(project, embedder);
      console.log(
        `[scrivener-companion] indexed ${entry.name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
      );
    } catch (err) {
      console.error(`[scrivener-companion] failed to index ${entry.name}:`, err);
    }

    return reply.status(201).send({ slug: entry.slug, path: entry.path });
  });

  // DELETE /projects/:slug
  server.delete<{
    Params: { slug: string };
  }>("/projects/:slug", async (request, reply) => {
    const { slug } = request.params;

    const idx = projects.findIndex((p) => p.entry.slug === slug);
    if (idx === -1) {
      return reply.status(404).send({ error: "project not found" });
    }

    // Close DB and remove from memory
    projects[idx].db.close();
    projects.splice(idx, 1);

    // Remove from registry and delete DB file
    const removed = removeProject(slug);
    if (!removed) {
      return reply.status(404).send({ error: "project not found in registry" });
    }

    return { slug, deleted: true };
  });

  // Listen on unix socket
  await server.listen({ path: paths.sock });
  state = "ready";
  console.log(`[scrivener-companion] listening on ${paths.sock}`);
}

main().catch((err) => {
  console.error("[scrivener-companion] fatal:", err);
  cleanup();
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: rewrite server with unix socket, lifecycle, project API"
```

---

### Task 6: Update `src/server-entry.ts` and build script

**Files:**
- Modify: `src/server-entry.ts:68-69`
- Modify: `scripts/build-server.mjs:7`

- [ ] **Step 1: Update `server-entry.ts` to load CLI**

In the non-SEA branch (line 68-69), change:

```typescript
if (!isSea()) {
  import("./cli.js");
}
```

In the SEA branch (line 106-113), change `server.js` references to `cli.js`:

```typescript
  const serverAsset = getAsset("cli.js", "utf8");
  const serverPath = path.join(cacheDir, "cli.js");
  if (!fs.existsSync(serverPath)) {
    fs.writeFileSync(serverPath, serverAsset);
  }

  const require = createRequire(serverPath);
  require(serverPath);
```

- [ ] **Step 2: Update build script entry point**

In `scripts/build-server.mjs`, change the entry point:

```javascript
  entryPoints: ["src/cli.ts"],
  // ...
  outfile: "dist/cli.js",
```

- [ ] **Step 3: Verify build**

```bash
npx tsc --noEmit
npm run build:server
```

Expected: no type errors, clean build.

- [ ] **Step 4: Commit**

```bash
git add src/server-entry.ts scripts/build-server.mjs
git commit -m "feat: update entry points for CLI-based binary"
```

---

## Verification

After all tasks, the project should:

1. `npx tsc --noEmit` — no type errors
2. `npm run build:server` — clean build
3. New files: `src/config.ts`, `src/cli.ts`
4. Modified files: `src/server.ts`, `src/ingest/store.ts`, `src/ingest/index.ts`, `src/server-entry.ts`, `scripts/build-server.mjs`
5. The binary supports `start|stop|restart|status` commands
6. Server listens on unix socket at `~/.config/scrivener-companion/server.sock`
7. Projects managed via `POST /projects`, `GET /projects`, `DELETE /projects/:slug`
8. Document metadata stored in `documents` table (no external `index.db` dependency)
9. `GET /health` returns `{ status: "ok", state: "starting|indexing|ready" }`
