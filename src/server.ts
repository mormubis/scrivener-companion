import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { Embedder } from "./embedder.js";
import {
  openVectorDb,
  insertChunk,
  deleteDocumentChunks,
  searchSimilar,
  hasDocumentChunks,
  type VectorSearchResult,
} from "./vector-store.js";
import { parseScrivProject, type ParsedDocument } from "./parser/scrivx.js";
import type Database from "better-sqlite3";

const PORT = 52718;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

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
// Indexing
// ---------------------------------------------------------------------------

async function indexProject(
  state: ProjectState,
  embedder: Embedder,
  documents: ParsedDocument[],
  force = false,
): Promise<number> {
  let totalChunks = 0;

  for (const doc of documents) {
    if (!force && hasDocumentChunks(state.vectorDb, doc.uuid)) {
      continue;
    }

    // Remove stale chunks before re-indexing
    deleteDocumentChunks(state.vectorDb, doc.uuid);

    const text = [doc.text, doc.notesText].filter(Boolean).join("\n\n");
    if (!text.trim()) continue;

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedder.embed(chunks[i]);
      insertChunk(state.vectorDb, doc.uuid, chunks[i], i, embedding);
      totalChunks++;
    }
  }

  return totalChunks;
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

    const vectorDb = openVectorDb(vectorDbPath);

    const state: ProjectState = { name, scrivPath, vectorDb, ftsDbPath };
    projects.push(state);

    console.log(`[writer-memory] indexing ${name}...`);
    try {
      const { documents } = parseScrivProject(scrivPath);
      const n = await indexProject(state, embedder, documents);
      console.log(`[writer-memory] indexed ${n} chunks for ${name}`);
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

    // Sort by distance across all projects, return topK overall
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, topK);
  });

  // POST /index — re-index all projects
  server.post("/index", async () => {
    let total = 0;
    for (const project of projects) {
      console.log(`[writer-memory] re-indexing ${project.name}...`);
      try {
        const { documents } = parseScrivProject(project.scrivPath);
        const n = await indexProject(project, embedder, documents, true);
        total += n;
        console.log(`[writer-memory] indexed ${n} chunks for ${project.name}`);
      } catch (err) {
        console.error(
          `[writer-memory] failed to re-index ${project.name}:`,
          err,
        );
      }
    }
    return { indexed: total };
  });

  await server.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[writer-memory] service running on port ${PORT}`);
}

main().catch((err) => {
  console.error("[writer-memory] fatal:", err);
  process.exit(1);
});
