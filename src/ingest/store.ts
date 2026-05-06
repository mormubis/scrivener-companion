import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const EMBEDDING_DIM = 384;

export function openDb(dbPath: string): Database.Database {
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

  const columns = db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[];
  const hasHash = columns.some((c) => c.name === "content_hash");
  if (!hasHash) {
    db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  }

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

  return db;
}

export function insertChunk(
  db: Database.Database,
  documentUuid: string,
  chunkText: string,
  chunkIndex: number,
  embedding: Float32Array,
  contentHash: string,
): void {
  const info = db
    .prepare(
      "INSERT INTO chunks (document_uuid, chunk_text, chunk_index, content_hash) VALUES (?, ?, ?, ?)",
    )
    .run(documentUuid, chunkText, chunkIndex, contentHash);

  db.prepare(
    "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)",
  ).run(BigInt(info.lastInsertRowid), embedding);
}

function deleteDocumentChunks(
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

export function getDocumentModifiedAt(
  db: Database.Database,
  uuid: string,
): number | null {
  const row = db
    .prepare("SELECT modified_at FROM documents WHERE uuid = ?")
    .get(uuid) as { modified_at: number } | undefined;
  return row?.modified_at ?? null;
}

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

export function getIndexedDocumentUuids(
  db: Database.Database,
): Set<string> {
  const rows = db
    .prepare("SELECT uuid FROM documents")
    .all() as { uuid: string }[];
  return new Set(rows.map((r) => r.uuid));
}

export function removeDocument(
  db: Database.Database,
  uuid: string,
): void {
  deleteDocumentChunks(db, uuid);
  db.prepare("DELETE FROM documents WHERE uuid = ?").run(uuid);
}

export interface StoredChunk {
  id: number;
  chunk_index: number;
  content_hash: string;
}

export function getChunksByDocument(
  db: Database.Database,
  uuid: string,
): StoredChunk[] {
  return db
    .prepare(
      "SELECT id, chunk_index, content_hash FROM chunks WHERE document_uuid = ? ORDER BY chunk_index",
    )
    .all(uuid) as StoredChunk[];
}

export function deleteChunkById(
  db: Database.Database,
  chunkId: number,
): void {
  db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?").run(chunkId);
  db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
}
