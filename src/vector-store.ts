import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const EMBEDDING_DIM = 384;

export function openVectorDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_uuid TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )
  `);

  return db;
}

export function insertChunk(
  db: Database.Database,
  documentUuid: string,
  chunkText: string,
  chunkIndex: number,
  embedding: Float32Array,
): void {
  const info = db
    .prepare(
      "INSERT INTO chunks (document_uuid, chunk_text, chunk_index) VALUES (?, ?, ?)",
    )
    .run(documentUuid, chunkText, chunkIndex);

  db.prepare(
    "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)",
  ).run(BigInt(info.lastInsertRowid), embedding);
}

export function deleteDocumentChunks(
  db: Database.Database,
  uuid: string,
): void {
  const chunkIds = db
    .prepare("SELECT id FROM chunks WHERE document_uuid = ?")
    .all(uuid) as { id: number }[];
  const delVec = db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
  for (const { id } of chunkIds) delVec.run(id);
  db.prepare("DELETE FROM chunks WHERE document_uuid = ?").run(uuid);
}

export interface VectorSearchResult {
  chunk_text: string;
  document_uuid: string;
  distance: number;
}

export function searchSimilar(
  db: Database.Database,
  queryEmbedding: Float32Array,
  topK: number = 10,
): VectorSearchResult[] {
  return db
    .prepare(
      `
    SELECT cv.distance, c.chunk_text, c.document_uuid
    FROM chunk_vectors cv
    JOIN chunks c ON c.id = cv.chunk_id
    WHERE cv.embedding MATCH ?
      AND cv.k = ?
    ORDER BY cv.distance
  `,
    )
    .all(queryEmbedding, topK) as VectorSearchResult[];
}

export function hasDocumentChunks(
  db: Database.Database,
  uuid: string,
): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM chunks WHERE document_uuid = ?")
    .get(uuid) as { c: number };
  return row.c > 0;
}
