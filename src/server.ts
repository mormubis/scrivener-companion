import { DatabaseSync } from "node:sqlite";
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
  type VectorSearchResult,
} from "./ingest/index.js";
import type Database from "better-sqlite3";

const PORT = 52718;

// ---------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------

interface ProjectState {
  name: string;
  scrivPath: string;
  vectorDb: Database.Database;
  ftsDbPath: string;
}

// ---------------------------------------------------------------------------
// Indexing (delta orchestration)
// ---------------------------------------------------------------------------

async function indexProject(
  state: ProjectState,
  embedder: Embedder,
  force = false,
): Promise<{ embedded: number; skipped: number; deleted: number }> {
  let embedded = 0;
  let skipped = 0;
  let deleted = 0;

  const { documents } = walk(state.scrivPath);

  // --- Phase 1: Delete orphaned documents ---
  const currentUuids = new Set(documents.map((d) => d.uuid));
  const indexedUuids = getIndexedDocumentUuids(state.vectorDb);

  for (const uuid of indexedUuids) {
    if (!currentUuids.has(uuid)) {
      removeDocument(state.vectorDb, uuid);
      deleted++;
    }
  }

  // --- Phase 2: Ingest new and modified documents ---
  for (const doc of documents) {
    if (!force) {
      const storedModifiedAt = getDocumentModifiedAt(state.vectorDb, doc.uuid);
      if (storedModifiedAt !== null && storedModifiedAt >= doc.modifiedAt) {
        skipped++;
        continue;
      }
    }

    const result = await ingest(doc, embedder, state.vectorDb);
    embedded += result.embedded;
    skipped += result.skipped;
  }

  return { embedded, skipped, deleted };
}

// ---------------------------------------------------------------------------
// Metadata lookup from FTS5 index.db
// ---------------------------------------------------------------------------

interface DocMeta {
  title: string;
  binder_path: string;
  binder_section: string;
  deep_link: string | null;
}

function lookupDocMeta(ftsDbPath: string, uuid: string): DocMeta | null {
  if (!fs.existsSync(ftsDbPath)) return null;
  const db = new DatabaseSync(ftsDbPath);
  try {
    const row = db
      .prepare(
        "SELECT title, binder_path, binder_section, deep_link FROM documents WHERE uuid = ?",
      )
      .get(uuid) as DocMeta | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scrivPaths = (process.env.WRITER_MEMORY_SCRIV_PATH ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const modelDir = process.env.WRITER_MEMORY_MODEL_DIR ?? "";

  if (!modelDir) {
    throw new Error("WRITER_MEMORY_MODEL_DIR is required");
  }

  // Initialize embedder
  const embedder = new Embedder(modelDir);
  await embedder.initialize();

  // Initialize project states and initial index
  const projects: ProjectState[] = [];

  for (const scrivPath of scrivPaths) {
    const projectDir = path.dirname(scrivPath);
    const memoryDir = path.join(projectDir, ".memory");

    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const vectorDbPath = path.join(memoryDir, "vectors.db");
    const ftsDbPath = path.join(memoryDir, "index.db");
    const name = path.basename(scrivPath, ".scriv");

    const vectorDb = openDb(vectorDbPath);

    const state: ProjectState = { name, scrivPath, vectorDb, ftsDbPath };
    projects.push(state);

    console.log(`[writer-memory] indexing ${name}...`);
    try {
      const stats = await indexProject(state, embedder);
      console.log(
        `[writer-memory] indexed ${name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
      );
    } catch (err) {
      console.error(`[writer-memory] failed to index ${name}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------

  const server = Fastify({ logger: false });

  // GET /health
  server.get("/health", async () => {
    return { status: "ok" };
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
        hits = searchSimilar(project.vectorDb, queryEmbedding, topK);
      } catch {
        hits = [];
      }

      for (const hit of hits) {
        const meta = lookupDocMeta(project.ftsDbPath, hit.document_uuid);
        results.push({
          chunk_text: hit.chunk_text,
          document_uuid: hit.document_uuid,
          title: meta?.title ?? null,
          binder_path: meta?.binder_path ?? null,
          binder_section: meta?.binder_section ?? null,
          deep_link: meta?.deep_link ?? null,
          distance: hit.distance,
          project: project.name,
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
      console.log(`[writer-memory] re-indexing ${project.name}...`);
      try {
        const stats = await indexProject(project, embedder, true);
        totals.embedded += stats.embedded;
        totals.skipped += stats.skipped;
        totals.deleted += stats.deleted;
        console.log(
          `[writer-memory] indexed ${project.name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
        );
      } catch (err) {
        console.error(
          `[writer-memory] failed to re-index ${project.name}:`,
          err,
        );
      }
    }
    return totals;
  });

  await server.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[writer-memory] service running on port ${PORT}`);
}

main().catch((err) => {
  console.error("[writer-memory] fatal:", err);
  process.exit(1);
});
