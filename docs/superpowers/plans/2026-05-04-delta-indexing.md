# Delta Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary "has chunks / no chunks" staleness check with full delta indexing that detects new, modified, and deleted documents — and avoids re-embedding unchanged chunks within modified documents.

**Architecture:** Add a `document_index` table that tracks per-document `modified_at` timestamps. Add a `content_hash` column to the `chunks` table so individual chunks can be compared by content. On each index pass: (1) delete chunks for documents no longer in the `.scriv` bundle, (2) skip documents whose `modified_at` hasn't changed, (3) for modified documents, only re-embed chunks whose text actually changed.

**Tech Stack:** Node.js, better-sqlite3, sqlite-vec, existing `crypto` stdlib for hashing.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/vector-store.ts` | Modify | Add `document_index` table, `content_hash` column, new query functions |
| `src/server.ts` | Modify | Rewrite `indexProject` to use delta logic |

---

### Task 1: Add `document_index` table and `content_hash` column to vector store

**Files:**
- Modify: `src/vector-store.ts:6-28` (schema in `openVectorDb`)
- Modify: `src/vector-store.ts:85-93` (replace `hasDocumentChunks`)

- [ ] **Step 1: Add `document_index` table to schema**

In `openVectorDb`, after the existing `CREATE TABLE IF NOT EXISTS chunks` and `CREATE VIRTUAL TABLE` statements, add:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS document_index (
    document_uuid TEXT PRIMARY KEY,
    modified_at REAL NOT NULL
  )
`);
```

- [ ] **Step 2: Add `content_hash` column to `chunks` table**

The `chunks` table needs a hash column to identify unchanged chunks. Since SQLite doesn't support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, use a migration approach:

```typescript
// After existing table creation
const columns = db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[];
const hasHash = columns.some((c) => c.name === "content_hash");
if (!hasHash) {
  db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
}
```

- [ ] **Step 3: Add `getDocumentModifiedAt` function**

Replace the existing `hasDocumentChunks` function with:

```typescript
export function getDocumentModifiedAt(
  db: Database.Database,
  uuid: string,
): number | null {
  const row = db
    .prepare("SELECT modified_at FROM document_index WHERE document_uuid = ?")
    .get(uuid) as { modified_at: number } | undefined;
  return row?.modified_at ?? null;
}
```

Keep `hasDocumentChunks` exported for now (it may still be imported elsewhere), but it won't be called by `indexProject` anymore.

- [ ] **Step 4: Add `upsertDocumentIndex` function**

```typescript
export function upsertDocumentIndex(
  db: Database.Database,
  uuid: string,
  modifiedAt: number,
): void {
  db.prepare(
    "INSERT INTO document_index (document_uuid, modified_at) VALUES (?, ?) ON CONFLICT(document_uuid) DO UPDATE SET modified_at = excluded.modified_at",
  ).run(uuid, modifiedAt);
}
```

- [ ] **Step 5: Add `getIndexedDocumentUuids` function**

This is needed to detect deleted documents (orphan cleanup).

```typescript
export function getIndexedDocumentUuids(
  db: Database.Database,
): Set<string> {
  const rows = db
    .prepare("SELECT document_uuid FROM document_index")
    .all() as { document_uuid: string }[];
  return new Set(rows.map((r) => r.document_uuid));
}
```

- [ ] **Step 6: Add `removeDocument` function**

Combines deleting chunks + removing the document_index row. This replaces raw `deleteDocumentChunks` calls for orphan cleanup.

```typescript
export function removeDocument(
  db: Database.Database,
  uuid: string,
): void {
  deleteDocumentChunks(db, uuid);
  db.prepare("DELETE FROM document_index WHERE document_uuid = ?").run(uuid);
}
```

- [ ] **Step 7: Add `getChunksByDocument` function**

Returns existing chunks for a document so we can diff at the chunk level.

```typescript
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
```

- [ ] **Step 8: Add `deleteChunkById` function**

For removing individual stale chunks (not the whole document).

```typescript
export function deleteChunkById(
  db: Database.Database,
  chunkId: number,
): void {
  db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?").run(chunkId);
  db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
}
```

- [ ] **Step 9: Update `insertChunk` to accept and store `contentHash`**

Modify the existing `insertChunk` signature:

```typescript
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
```

- [ ] **Step 10: Update exports**

Make sure the module exports all new functions. Update the top of the file or the export list as needed:

```typescript
export {
  openVectorDb,
  insertChunk,
  deleteDocumentChunks,
  deleteChunkById,
  searchSimilar,
  hasDocumentChunks,
  getDocumentModifiedAt,
  upsertDocumentIndex,
  getIndexedDocumentUuids,
  removeDocument,
  getChunksByDocument,
};
```

(All functions are already individually exported with `export function`, so no separate export block is needed — just verify nothing was accidentally un-exported.)

- [ ] **Step 11: Commit**

```bash
git add src/vector-store.ts
git commit -m "feat: add document_index table and content_hash for delta indexing"
```

---

### Task 2: Rewrite `indexProject` with delta logic

**Files:**
- Modify: `src/server.ts:1-13` (imports)
- Modify: `src/server.ts:52-80` (`indexProject` function)

- [ ] **Step 1: Add `crypto` import and update vector-store imports**

At the top of `server.ts`:

```typescript
import crypto from "node:crypto";
```

Update the vector-store import to include the new functions:

```typescript
import {
  openVectorDb,
  insertChunk,
  deleteDocumentChunks,
  deleteChunkById,
  searchSimilar,
  getDocumentModifiedAt,
  upsertDocumentIndex,
  getIndexedDocumentUuids,
  removeDocument,
  getChunksByDocument,
  type VectorSearchResult,
} from "./vector-store.js";
```

Remove `hasDocumentChunks` from the import — it's no longer used here.

- [ ] **Step 2: Add a `hashChunk` helper**

Below the `chunkText` function:

```typescript
function hashChunk(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
```

- [ ] **Step 3: Rewrite `indexProject` with full delta logic**

Replace the entire `indexProject` function (lines 52-80):

```typescript
async function indexProject(
  state: ProjectState,
  embedder: Embedder,
  documents: ParsedDocument[],
  force = false,
): Promise<{ embedded: number; skipped: number; deleted: number }> {
  let embedded = 0;
  let skipped = 0;
  let deleted = 0;

  // --- Phase 1: Delete orphaned documents ---
  const currentUuids = new Set(documents.map((d) => d.uuid));
  const indexedUuids = getIndexedDocumentUuids(state.vectorDb);

  for (const uuid of indexedUuids) {
    if (!currentUuids.has(uuid)) {
      removeDocument(state.vectorDb, uuid);
      deleted++;
    }
  }

  // --- Phase 2: Index new and modified documents ---
  for (const doc of documents) {
    const text = [doc.text, doc.notesText].filter(Boolean).join("\n\n");
    if (!text.trim()) continue;

    // Check if document needs re-indexing
    if (!force) {
      const storedModifiedAt = getDocumentModifiedAt(state.vectorDb, doc.uuid);
      if (storedModifiedAt !== null && storedModifiedAt >= doc.modifiedAt) {
        skipped++;
        continue;
      }
    }

    // Build new chunks with hashes
    const newChunks = chunkText(text);
    const newHashes = newChunks.map(hashChunk);

    // Build a map of existing chunks by index for diffing
    const existingChunks = getChunksByDocument(state.vectorDb, doc.uuid);
    const existingByIndex = new Map(
      existingChunks.map((c) => [c.chunk_index, c]),
    );

    // Track which existing chunk indices we've matched
    const matchedIndices = new Set<number>();

    for (let i = 0; i < newChunks.length; i++) {
      const existing = existingByIndex.get(i);

      if (existing && existing.content_hash === newHashes[i]) {
        // Chunk unchanged — skip embedding
        matchedIndices.add(i);
        skipped++;
        continue;
      }

      // Chunk is new or changed — delete old if exists, insert new
      if (existing) {
        deleteChunkById(state.vectorDb, existing.id);
      }

      const embedding = await embedder.embed(newChunks[i]);
      insertChunk(
        state.vectorDb,
        doc.uuid,
        newChunks[i],
        i,
        embedding,
        newHashes[i],
      );
      embedded++;
    }

    // Delete trailing chunks that no longer exist
    // (document got shorter — old chunks beyond new length)
    for (const existing of existingChunks) {
      if (
        existing.chunk_index >= newChunks.length &&
        !matchedIndices.has(existing.chunk_index)
      ) {
        deleteChunkById(state.vectorDb, existing.id);
        deleted++;
      }
    }

    // Update document index timestamp
    upsertDocumentIndex(state.vectorDb, doc.uuid, doc.modifiedAt);
  }

  return { embedded, skipped, deleted };
}
```

- [ ] **Step 4: Update startup indexing log to use new return type**

In `main()`, update lines 148-152:

```typescript
console.log(`[writer-memory] indexing ${name}...`);
const { documents } = parseScrivProject(scrivPath);
const stats = await indexProject(state, embedder, documents);
console.log(
  `[writer-memory] indexed ${name}: ${stats.embedded} embedded, ${stats.skipped} skipped, ${stats.deleted} deleted`,
);
```

- [ ] **Step 5: Update `/index` endpoint to use new return type**

In the `POST /index` handler, update lines 221-237:

```typescript
server.post("/index", async () => {
  const totals = { embedded: 0, skipped: 0, deleted: 0 };
  for (const project of projects) {
    console.log(`[writer-memory] re-indexing ${project.name}...`);
    try {
      const { documents } = parseScrivProject(project.scrivPath);
      const stats = await indexProject(project, embedder, documents, true);
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
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: rewrite indexProject with full delta logic"
```

---

### Task 3: Verify build

**Files:** none (verification only)

- [ ] **Step 1: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run esbuild**

```bash
npm run build:server
```

Expected: clean build.

- [ ] **Step 3: Commit any fixes if needed**

---

## Behavior Summary

After implementation, `indexProject` handles all delta cases:

| Case | Before | After |
|------|--------|-------|
| **New document** (not in DB) | Embedded | Embedded |
| **Unchanged document** (same `modifiedAt`) | Skipped (if chunks exist) | Skipped (by timestamp) |
| **Modified document, same chunk** | Re-embedded everything | Skipped (by content hash) |
| **Modified document, changed chunk** | Re-embedded everything | Only changed chunks re-embedded |
| **Modified document, fewer chunks** | Re-embedded everything | Trailing chunks deleted |
| **Deleted document** (no longer in `.scriv`) | Orphaned forever | Chunks + index row deleted |
| **Force re-index** | Delete all + re-embed all | Delete all + re-embed all (unchanged) |

Note on `force=true`: even with force, chunks whose content hash matches are still skipped. The `force` flag bypasses the `modifiedAt` timestamp check but chunk-level diffing still applies. This makes force re-index faster than a full teardown while still catching any corruption.
