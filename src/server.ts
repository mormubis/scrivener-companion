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
  fs.writeFileSync(paths.lock, String(process.pid) + "\n");
  return fd;
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

  // HTTP server (created early so shutdown handler can reference it)
  const server = Fastify({ logger: false });

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
  // Routes
  // ---------------------------------------------------------------------------

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
