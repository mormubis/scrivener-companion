# Ingest Pipeline Design

## Goal

Extract the indexing logic from `server.ts` into a dedicated `src/ingest/` module with five explicit pipeline steps: walk, parse, chunk, embed, store. The server becomes a thin HTTP layer that handles delta orchestration (what to process) while `ingest/` handles the pure transformation (how to process).

## Architecture

The pipeline transforms a `.scriv` bundle into stored embeddings through five sequential steps. Each step has a single responsibility, takes input from the previous step, and produces output for the next. The server owns delta logic (mtime checks, hash diffing, orphan cleanup) and calls individual pipeline steps as needed.

```
.scriv bundle → walk → parse → chunk → embed → store
```

## File Structure

```
src/
  ingest/
    walk.ts    — read .scrivx XML, walk binder tree, discover documents, build deep links
    parse.ts   — read RTF files, convert to plain text (RTF logic inlined)
    chunk.ts   — split text into overlapping pieces + SHA-256 hash
    embed.ts   — generate embeddings via ONNX model
    store.ts   — write chunks + embeddings to SQLite, schema, queries
    index.ts   — compose all steps, export ingest()
  server.ts    — HTTP routing + delta orchestration
  server-entry.ts — SEA entry point (unchanged)
```

### What goes away

- `src/parser/` — entire directory removed
  - `scrivx.ts` → split between `ingest/walk.ts` (binder walking, metadata, deep links) and `ingest/parse.ts` (RTF reading)
  - `rtf.ts` → inlined into `ingest/parse.ts`
  - `deep-links.ts` → inlined into `ingest/walk.ts` (single function, 4 lines)
- `src/embedder.ts` → becomes `ingest/embed.ts`
- `src/vector-store.ts` → becomes `ingest/store.ts`

## Step Interfaces

### walk

Reads the `.scrivx` XML inside a `.scriv` bundle, walks the binder tree, and discovers all documents with their metadata and file paths. Does not read document content.

```typescript
interface WalkedDocument {
  uuid: string;
  title: string;
  binderPath: string;
  binderSection: string;
  docType: string;
  label: string | null;
  status: string | null;
  sectionType: string | null;
  includeInCompile: boolean;
  contentPath: string;      // absolute path to content.rtf
  notesPath: string | null;  // absolute path to notes.rtf, null if doesn't exist
  deepLink: string;
  modifiedAt: number;        // mtime of content.rtf
}

interface BinderItem {
  uuid: string;
  title: string;
  type: string;
  children: BinderItem[];
}

interface WalkResult {
  binderTree: BinderItem[];
  documents: WalkedDocument[];
}

function walk(scrivPath: string): WalkResult;
```

Also exports `renderBinderTree()` which currently lives in `scrivx.ts`.

### parse

Takes a `WalkedDocument`, reads its RTF files from disk, and converts them to plain text. The RTF-to-text conversion logic (currently in `parser/rtf.ts`, ~186 lines including Windows-1252 codepage handling) is inlined into this module.

```typescript
interface ParsedDocument {
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
  text: string;
  notesText: string | null;
}

function parse(doc: WalkedDocument): ParsedDocument | null;
```

Returns `null` if the document has no text content (empty RTF or no content.rtf). The caller filters these out.

### chunk

Splits a text string into overlapping pieces and hashes each one. Pure function, no I/O.

```typescript
interface Chunk {
  text: string;
  index: number;
  hash: string;  // SHA-256 hex
}

function chunk(text: string): Chunk[];
```

Uses `CHUNK_SIZE = 384` chars with `CHUNK_OVERLAP = 64` chars. These constants are defined in this module.

### embed

Wraps the HuggingFace transformers pipeline. Stateful — needs initialization with a model directory before use.

```typescript
class Embedder {
  constructor(modelDir: string);
  initialize(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
}
```

Same interface as the current `src/embedder.ts`. Moved, not changed.

### store

Manages the SQLite + sqlite-vec database. Schema creation, chunk CRUD, vector search, document index tracking.

```typescript
// Schema: chunks, chunk_vectors, document_index tables
function openDb(dbPath: string): Database.Database;

// Write operations
function insertChunk(db, uuid, text, index, embedding, hash): void;
function deleteChunkById(db, chunkId): void;
function removeDocument(db, uuid): void;
function upsertDocumentIndex(db, uuid, modifiedAt): void;

// Read operations
function searchSimilar(db, queryEmbedding, topK): VectorSearchResult[];
function getDocumentModifiedAt(db, uuid): number | null;
function getIndexedDocumentUuids(db): Set<string>;
function getChunksByDocument(db, uuid): StoredChunk[];
```

Same logic as current `src/vector-store.ts`. Renamed `openVectorDb` → `openDb` since it's the only DB in the module.

### index.ts — pipeline composition

Exports an `ingest()` function that runs all five steps for a single document. The server calls this per-document after deciding what needs processing.

```typescript
interface IngestResult {
  embedded: number;
  skipped: number;
}

async function ingest(
  doc: WalkedDocument,
  embedder: Embedder,
  db: Database.Database,
): Promise<IngestResult>;
```

Also re-exports the types and functions that the server needs: `walk`, `Embedder`, store functions, `BinderItem`, `WalkedDocument`, `ParsedDocument`, etc.

## Server Responsibilities

After this refactor, `server.ts` is responsible for:

1. **Configuration** — reading env vars, setting up project states
2. **Delta orchestration** — calling `walk()`, comparing against stored state (mtime, hashes, orphans), deciding what to process
3. **HTTP routing** — `/health`, `/search`, `/index` endpoints
4. **Metadata lookup** — querying the FTS `index.db` for titles, binder paths, deep links

The delta logic (`indexProject` function) stays in `server.ts`. It calls `walk()` to get the document list, then calls `ingest()` for each document that needs processing. Orphan cleanup also stays in the server since it's a delta concern, not a transformation concern.

## What Does Not Change

- `server-entry.ts` — SEA entry point, unchanged
- `scripts/` — build scripts, model downloader, unchanged
- HTTP API contract — same endpoints, same request/response shapes
- Delta indexing behavior — same mtime + hash diffing logic
- Database schema — same tables, same columns
- `.github/workflows/` — CI unchanged
