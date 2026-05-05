# Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the indexing pipeline into a dedicated `src/ingest/` module with five explicit steps (walk, parse, chunk, embed, store), removing `src/parser/`, `src/embedder.ts`, and `src/vector-store.ts`.

**Architecture:** Each step is its own file in `src/ingest/` with a clear interface. `index.ts` composes them into a single `ingest()` function for per-document processing. The server keeps delta orchestration (mtime, hash diffing, orphan cleanup) and HTTP routing. This is a pure refactor — no behavior changes.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, @huggingface/transformers, fast-xml-parser, esbuild

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/ingest/walk.ts` | Create | Read .scrivx XML, walk binder, discover docs, build deep links |
| `src/ingest/parse.ts` | Create | Read RTF files, convert to plain text (RTF logic inlined) |
| `src/ingest/chunk.ts` | Create | Split text into overlapping pieces + SHA-256 hash |
| `src/ingest/embed.ts` | Create | Generate embeddings via ONNX model |
| `src/ingest/store.ts` | Create | SQLite + sqlite-vec database operations |
| `src/ingest/index.ts` | Create | Compose steps, export ingest() and re-export types |
| `src/server.ts` | Modify | Update imports to use ingest/, remove moved code |
| `src/parser/scrivx.ts` | Delete | Replaced by ingest/walk.ts + ingest/parse.ts |
| `src/parser/rtf.ts` | Delete | Inlined into ingest/parse.ts |
| `src/parser/deep-links.ts` | Delete | Inlined into ingest/walk.ts |
| `src/embedder.ts` | Delete | Replaced by ingest/embed.ts |
| `src/vector-store.ts` | Delete | Replaced by ingest/store.ts |

---

### Task 1: Create `src/ingest/store.ts`

Move `src/vector-store.ts` into the new location with the rename `openVectorDb` → `openDb`.

**Files:**
- Create: `src/ingest/store.ts`

- [ ] **Step 1: Create `src/ingest/` directory**

```bash
mkdir -p src/ingest
```

- [ ] **Step 2: Write `src/ingest/store.ts`**

This is the current `src/vector-store.ts` with `openVectorDb` renamed to `openDb`:

```typescript
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
    CREATE TABLE IF NOT EXISTS document_index (
      document_uuid TEXT PRIMARY KEY,
      modified_at REAL NOT NULL
    )
  `);

  const columns = db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[];
  const hasHash = columns.some((c) => c.name === "content_hash");
  if (!hasHash) {
    db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
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
    .prepare("SELECT modified_at FROM document_index WHERE document_uuid = ?")
    .get(uuid) as { modified_at: number } | undefined;
  return row?.modified_at ?? null;
}

export function upsertDocumentIndex(
  db: Database.Database,
  uuid: string,
  modifiedAt: number,
): void {
  db.prepare(
    "INSERT INTO document_index (document_uuid, modified_at) VALUES (?, ?) ON CONFLICT(document_uuid) DO UPDATE SET modified_at = excluded.modified_at",
  ).run(uuid, modifiedAt);
}

export function getIndexedDocumentUuids(
  db: Database.Database,
): Set<string> {
  const rows = db
    .prepare("SELECT document_uuid FROM document_index")
    .all() as { document_uuid: string }[];
  return new Set(rows.map((r) => r.document_uuid));
}

export function removeDocument(
  db: Database.Database,
  uuid: string,
): void {
  deleteDocumentChunks(db, uuid);
  db.prepare("DELETE FROM document_index WHERE document_uuid = ?").run(uuid);
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
```

- [ ] **Step 3: Commit**

```bash
git add src/ingest/store.ts
git commit -m "refactor: create ingest/store.ts from vector-store.ts"
```

---

### Task 2: Create `src/ingest/embed.ts`

Move `src/embedder.ts` into the new location. No changes to the code.

**Files:**
- Create: `src/ingest/embed.ts`

- [ ] **Step 1: Write `src/ingest/embed.ts`**

```typescript
import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

export class Embedder {
  private pipe: FeatureExtractionPipeline | null = null;
  private modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async initialize(): Promise<void> {
    this.pipe = (await pipeline("feature-extraction", this.modelDir, {
      local_files_only: true,
    })) as FeatureExtractionPipeline;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error("Embedder not initialized");

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data as Float64Array);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ingest/embed.ts
git commit -m "refactor: create ingest/embed.ts from embedder.ts"
```

---

### Task 3: Create `src/ingest/chunk.ts`

Extract chunking + hashing logic from `server.ts` into its own module.

**Files:**
- Create: `src/ingest/chunk.ts`

- [ ] **Step 1: Write `src/ingest/chunk.ts`**

```typescript
import crypto from "node:crypto";

const CHUNK_SIZE = 384;
const CHUNK_OVERLAP = 64;

export interface Chunk {
  text: string;
  index: number;
  hash: string;
}

export function chunk(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let i = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const slice = text.slice(start, end);
    chunks.push({
      text: slice,
      index: i,
      hash: crypto.createHash("sha256").update(slice).digest("hex"),
    });
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    i++;
  }
  return chunks;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ingest/chunk.ts
git commit -m "refactor: create ingest/chunk.ts from server.ts chunking logic"
```

---

### Task 4: Create `src/ingest/walk.ts`

Split the binder-walking and document-discovery logic out of `src/parser/scrivx.ts`. This module reads the `.scrivx` XML, walks the binder tree, resolves metadata, and discovers document file paths — but does NOT read RTF content. Deep link building is inlined.

**Files:**
- Create: `src/ingest/walk.ts`

- [ ] **Step 1: Write `src/ingest/walk.ts`**

```typescript
import { XMLParser } from "fast-xml-parser";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BinderItem {
  uuid: string;
  title: string;
  type: string;
  children: BinderItem[];
}

export interface WalkedDocument {
  uuid: string;
  title: string;
  binderPath: string;
  binderSection: string;
  docType: string;
  label: string | null;
  status: string | null;
  sectionType: string | null;
  includeInCompile: boolean;
  contentPath: string;
  notesPath: string | null;
  deepLink: string;
  modifiedAt: number;
}

export interface WalkResult {
  binderTree: BinderItem[];
  documents: WalkedDocument[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ParsedXml = Record<string, unknown>;

// Types that represent top-level binder sections
const SECTION_TYPES = new Set(["DraftFolder", "ResearchFolder", "Folder"]);

// Types to skip entirely (trash and media)
const SKIP_TYPES = new Set(["TrashFolder", "PDF", "WebArchive"]);

// Types that can have text content
const TEXT_TYPES = new Set(["Text", "Folder", "DraftFolder", "ResearchFolder"]);

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

function buildDeepLink(scrivPath: string, documentUuid: string): string {
  const absolutePath = path.resolve(scrivPath);
  return `x-scrivener-item://${absolutePath}?id=${documentUuid}`;
}

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------

export function walk(scrivPath: string): WalkResult {
  const entries = fs.readdirSync(scrivPath);
  const scrivxFile = entries.find((e) => e.endsWith(".scrivx"));
  if (!scrivxFile) {
    throw new Error(`No .scrivx file found in ${scrivPath}`);
  }

  const scrivxPath = path.join(scrivPath, scrivxFile);
  const xml = fs.readFileSync(scrivxPath, "utf-8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["BinderItem", "Label", "Status", "Type"].includes(name),
  });
  const parsed = parser.parse(xml) as ParsedXml;

  const scrivenerProject = parsed?.ScrivenerProject as ParsedXml | undefined;
  const binder = (scrivenerProject?.Binder as ParsedXml | undefined)
    ?.BinderItem;
  if (!binder) {
    throw new Error("Could not find Binder in .scrivx");
  }

  const labelMap = buildLabelMap(parsed);
  const statusMap = buildStatusMap(parsed);
  const sectionTypeMap = buildSectionTypeMap(parsed);

  const documents: WalkedDocument[] = [];

  function walkBinder(
    items: ParsedXml[],
    parentPath: string,
    binderSection: string,
  ): BinderItem[] {
    const result: BinderItem[] = [];

    for (const item of items) {
      const uuid = item["@_UUID"] as string | undefined;
      const type: string = (item["@_Type"] as string | undefined) ?? "Other";
      const title: string = (item.Title as string | undefined) ?? "Untitled";

      if (SKIP_TYPES.has(type)) {
        continue;
      }

      const binderPath = parentPath ? `${parentPath}/${title}` : title;

      const childSection =
        parentPath === "" && SECTION_TYPES.has(type) ? title : binderSection;

      const childrenNode = item.Children as ParsedXml | undefined;
      const childItems = childrenNode?.BinderItem;
      const children = childItems
        ? walkBinder(
            Array.isArray(childItems) ? childItems : [childItems as ParsedXml],
            binderPath,
            childSection,
          )
        : [];

      result.push({ uuid: uuid ?? "", title, type, children });

      if (!uuid || !TEXT_TYPES.has(type)) {
        continue;
      }

      const contentPath = path.join(
        scrivPath,
        "Files",
        "Data",
        uuid,
        "content.rtf",
      );
      if (!fs.existsSync(contentPath)) {
        continue;
      }

      const stat = fs.statSync(contentPath);

      // Resolve metadata
      const meta = (item.MetaData as ParsedXml | undefined) ?? {};

      const labelId = meta.LabelID != null ? String(meta.LabelID) : null;
      const label =
        labelId !== null && labelId !== "-1"
          ? (labelMap.get(labelId) ?? null)
          : null;

      const statusId = meta.StatusID != null ? String(meta.StatusID) : null;
      const status =
        statusId !== null && statusId !== "-1"
          ? (statusMap.get(statusId) ?? null)
          : null;

      const sectionTypeRaw = meta.SectionType;
      let sectionTypeUuid: string | null = null;
      if (sectionTypeRaw != null) {
        if (typeof sectionTypeRaw === "object") {
          const sectionTypeObj = sectionTypeRaw as ParsedXml;
          const sectionText = sectionTypeObj["#text"];
          sectionTypeUuid = sectionText != null ? String(sectionText) : null;
        } else {
          sectionTypeUuid = String(sectionTypeRaw);
        }
      }
      const sectionType =
        sectionTypeUuid !== null
          ? (sectionTypeMap.get(sectionTypeUuid) ?? null)
          : null;

      const includeInCompile =
        meta.IncludeInCompile != null
          ? String(meta.IncludeInCompile).toLowerCase() !== "no"
          : true;

      const notesPath = path.join(
        scrivPath,
        "Files",
        "Data",
        uuid,
        "notes.rtf",
      );

      documents.push({
        uuid,
        title,
        binderPath,
        binderSection: childSection,
        docType: type,
        label,
        status,
        sectionType,
        includeInCompile,
        contentPath,
        notesPath: fs.existsSync(notesPath) ? notesPath : null,
        deepLink: buildDeepLink(scrivPath, uuid),
        modifiedAt: stat.mtimeMs,
      });
    }

    return result;
  }

  const topLevelItems = Array.isArray(binder)
    ? (binder as ParsedXml[])
    : [binder as ParsedXml];
  const binderTree = walkBinder(topLevelItems, "", "");

  return { binderTree, documents };
}

// ---------------------------------------------------------------------------
// Binder tree rendering
// ---------------------------------------------------------------------------

export function renderBinderTree(
  items: BinderItem[],
  indent: number = 0,
): string {
  let result = "";
  for (const item of items) {
    const prefix = "  ".repeat(indent);
    const icon = item.type === "Folder" ? "[Folder]" : "[Doc]";
    result += `${prefix}${icon} ${item.title}\n`;
    if (item.children.length > 0) {
      result += renderBinderTree(item.children, indent + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metadata lookup helpers
// ---------------------------------------------------------------------------

function buildLabelMap(parsed: ParsedXml): Map<string, string> {
  const map = new Map<string, string>();
  const project = parsed?.ScrivenerProject as ParsedXml | undefined;
  const labels: ParsedXml[] =
    (((project?.LabelSettings as ParsedXml)?.Labels as ParsedXml)
      ?.Label as ParsedXml[]) ?? [];
  for (const label of labels) {
    const id = String(label["@_ID"]);
    const name =
      typeof label === "object" ? String(label["#text"] ?? "") : String(label);
    if (id !== "-1" && name) {
      map.set(id, name);
    }
  }
  return map;
}

function buildStatusMap(parsed: ParsedXml): Map<string, string> {
  const map = new Map<string, string>();
  const project = parsed?.ScrivenerProject as ParsedXml | undefined;
  const statuses: ParsedXml[] =
    (((project?.StatusSettings as ParsedXml)?.StatusItems as ParsedXml)
      ?.Status as ParsedXml[]) ?? [];
  for (const status of statuses) {
    const id = String(status["@_ID"]);
    const name =
      typeof status === "object"
        ? String(status["#text"] ?? "")
        : String(status);
    if (id !== "-1" && name) {
      map.set(id, name);
    }
  }
  return map;
}

function buildSectionTypeMap(parsed: ParsedXml): Map<string, string> {
  const map = new Map<string, string>();
  const project = parsed?.ScrivenerProject as ParsedXml | undefined;
  const types: ParsedXml[] =
    (((project?.SectionTypes as ParsedXml)?.TypeDefinitions as ParsedXml)
      ?.Type as ParsedXml[]) ?? [];
  for (const t of types) {
    const id = String(t["@_ID"]);
    const name = typeof t === "object" ? String(t["#text"] ?? "") : String(t);
    if (id && name) {
      map.set(id, name);
    }
  }
  return map;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ingest/walk.ts
git commit -m "refactor: create ingest/walk.ts from parser/scrivx.ts"
```

---

### Task 5: Create `src/ingest/parse.ts`

Extract RTF reading and conversion. This module takes a `WalkedDocument`, reads its RTF files from disk, and converts them to plain text. The entire RTF parser (currently `src/parser/rtf.ts`) is inlined here.

**Files:**
- Create: `src/ingest/parse.ts`

- [ ] **Step 1: Write `src/ingest/parse.ts`**

```typescript
import fs from "node:fs";
import type { WalkedDocument } from "./walk.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDocument {
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

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parse(doc: WalkedDocument): ParsedDocument | null {
  const rtf = fs.readFileSync(doc.contentPath, "utf-8");
  const text = rtfToText(rtf);

  if (text.length === 0) {
    return null;
  }

  let notesText: string | null = null;
  if (doc.notesPath) {
    const notesRtf = fs.readFileSync(doc.notesPath, "utf-8");
    const parsed = rtfToText(notesRtf);
    notesText = parsed.length > 0 ? parsed : null;
  }

  return {
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
    text,
    notesText,
  };
}

// ---------------------------------------------------------------------------
// RTF to text conversion
// ---------------------------------------------------------------------------

// Windows-1252 bytes 0x80-0x9F that differ from ISO-8859-1
const CP1252: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

function cp1252ToChar(code: number): string {
  if (code >= 0x80 && code <= 0x9f && CP1252[code]) {
    return CP1252[code];
  }
  return String.fromCharCode(code);
}

function rtfToText(rtf: string): string {
  let text = "";
  let i = 0;
  let skipGroup = false;
  const skipGroupStack: boolean[] = [];

  while (i < rtf.length) {
    const char = rtf[i];

    if (char === "{") {
      skipGroupStack.push(skipGroup);
      const ahead = rtf.slice(i + 1, i + 30);
      if (
        ahead.startsWith("\\fonttbl") ||
        ahead.startsWith("\\colortbl") ||
        ahead.startsWith("\\stylesheet") ||
        ahead.startsWith("\\info") ||
        ahead.startsWith("\\*\\")
      ) {
        skipGroup = true;
      }
      i++;
      continue;
    }

    if (char === "}") {
      skipGroup = skipGroupStack.pop() ?? false;
      i++;
      continue;
    }

    if (skipGroup) {
      i++;
      continue;
    }

    if (char === "\\") {
      i++;
      if (i >= rtf.length) break;

      const nextChar = rtf[i];

      if (nextChar === "{" || nextChar === "}" || nextChar === "\\") {
        text += nextChar;
        i++;
        continue;
      }

      if (nextChar === "'") {
        i++;
        const hex = rtf.slice(i, i + 2);
        i += 2;
        const code = parseInt(hex, 16);
        if (!isNaN(code)) {
          text += cp1252ToChar(code);
        }
        continue;
      }

      if (nextChar === "\n" || nextChar === "\r") {
        i++;
        continue;
      }

      let controlWord = "";
      while (i < rtf.length && /[a-zA-Z]/.test(rtf[i])) {
        controlWord += rtf[i];
        i++;
      }

      let param = "";
      if (i < rtf.length && (rtf[i] === "-" || /[0-9]/.test(rtf[i]))) {
        if (rtf[i] === "-") {
          param += "-";
          i++;
        }
        while (i < rtf.length && /[0-9]/.test(rtf[i])) {
          param += rtf[i];
          i++;
        }
      }

      if (i < rtf.length && rtf[i] === " ") {
        i++;
      }

      if (controlWord === "par" || controlWord === "line") {
        text += "\n";
      } else if (controlWord === "tab") {
        text += "\t";
      } else if (controlWord === "u") {
        const codePoint = parseInt(param, 10);
        if (!isNaN(codePoint)) {
          text += String.fromCodePoint(
            codePoint < 0 ? codePoint + 65536 : codePoint,
          );
        }
        if (
          i < rtf.length &&
          rtf[i] !== "\\" &&
          rtf[i] !== "{" &&
          rtf[i] !== "}"
        ) {
          i++;
        }
      } else if (controlWord === "lquote") {
        text += "\u2018";
      } else if (controlWord === "rquote") {
        text += "\u2019";
      } else if (controlWord === "ldblquote") {
        text += "\u201C";
      } else if (controlWord === "rdblquote") {
        text += "\u201D";
      } else if (controlWord === "emdash") {
        text += "\u2014";
      } else if (controlWord === "endash") {
        text += "\u2013";
      } else if (controlWord === "bullet") {
        text += "\u2022";
      }

      continue;
    }

    text += char;
    i++;
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ingest/parse.ts
git commit -m "refactor: create ingest/parse.ts with inlined RTF conversion"
```

---

### Task 6: Create `src/ingest/index.ts`

Compose all steps and re-export types the server needs.

**Files:**
- Create: `src/ingest/index.ts`

- [ ] **Step 1: Write `src/ingest/index.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/ingest/index.ts
git commit -m "refactor: create ingest/index.ts pipeline composition"
```

---

### Task 7: Update `src/server.ts` and delete old files

Rewrite server imports to use `src/ingest/`, remove all moved code (chunking, hashing), update `indexProject` to use `ingest()`, and delete the old source files.

**Files:**
- Modify: `src/server.ts`
- Delete: `src/parser/scrivx.ts`
- Delete: `src/parser/rtf.ts`
- Delete: `src/parser/deep-links.ts`
- Delete: `src/embedder.ts`
- Delete: `src/vector-store.ts`

- [ ] **Step 1: Rewrite `src/server.ts`**

Replace the entire file with:

```typescript
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
```

- [ ] **Step 2: Delete old files**

```bash
rm src/vector-store.ts
rm src/embedder.ts
rm -rf src/parser
```

- [ ] **Step 3: Verify build**

```bash
npx tsc --noEmit
npm run build:server
```

Expected: no type errors, clean build.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: migrate to ingest/ pipeline, remove old modules"
```

---

## Verification

After all tasks, the project should:

1. `npx tsc --noEmit` — no type errors
2. `npm run build:server` — clean build to `dist/server.js`
3. `src/parser/`, `src/embedder.ts`, `src/vector-store.ts` no longer exist
4. All code lives in `src/ingest/` (5 steps + index), `src/server.ts`, `src/server-entry.ts`
5. No behavior changes — same HTTP API, same delta logic, same DB schema
