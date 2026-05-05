import type Database from "better-sqlite3";
import { walk } from "./walk.js";
import { parse } from "./parse.js";
import { chunk } from "./chunk.js";
import { Embedder } from "./embed.js";
import { insertChunk, deleteChunkById, getChunksByDocument, upsertDocumentIndex } from "./store.js";
import type { WalkedDocument } from "./walk.js";

export interface IngestResult {
  embedded: number;
  skipped: number;
}

export async function ingest(
  doc: WalkedDocument,
  embedder: Embedder,
  db: Database.Database,
): Promise<IngestResult> {
  let embedded = 0;
  let skipped = 0;

  const parsed = parse(doc);
  if (!parsed) {
    return { embedded, skipped };
  }

  const text = [parsed.text, parsed.notesText].filter(Boolean).join("\n\n");
  const newChunks = chunk(text);

  const existingChunks = getChunksByDocument(db, doc.uuid);
  const existingByIndex = new Map(
    existingChunks.map((c) => [c.chunk_index, c]),
  );

  for (const c of newChunks) {
    const existing = existingByIndex.get(c.index);

    if (existing && existing.content_hash === c.hash) {
      skipped++;
      continue;
    }

    if (existing) {
      deleteChunkById(db, existing.id);
    }

    const embedding = await embedder.embed(c.text);
    insertChunk(db, doc.uuid, c.text, c.index, embedding, c.hash);
    embedded++;
  }

  // Delete trailing chunks (document got shorter)
  for (const existing of existingChunks) {
    if (existing.chunk_index >= newChunks.length) {
      deleteChunkById(db, existing.id);
    }
  }

  upsertDocumentIndex(db, doc.uuid, doc.modifiedAt);

  return { embedded, skipped };
}

// Re-exports for server consumption
export { walk, renderBinderTree } from "./walk.js";
export type { BinderItem, WalkedDocument, WalkResult } from "./walk.js";
export { parse } from "./parse.js";
export type { ParsedDocument } from "./parse.js";
export { chunk } from "./chunk.js";
export type { Chunk } from "./chunk.js";
export { Embedder } from "./embed.js";
export {
  openDb,
  insertChunk,
  deleteChunkById,
  searchSimilar,
  getDocumentModifiedAt,
  upsertDocumentIndex,
  getIndexedDocumentUuids,
  removeDocument,
  getChunksByDocument,
} from "./store.js";
export type { VectorSearchResult, StoredChunk } from "./store.js";
