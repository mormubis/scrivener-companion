# Server Redesign Design

## Goal

Transform the scrivener-companion from a hardcoded HTTP server into a proper daemon with CLI lifecycle management, unix domain socket communication, centralized configuration, project registry, and self-contained metadata storage.

## Architecture

The binary becomes a CLI tool (`scrivener-companion start|stop|restart|status`) that manages a background daemon. The daemon listens on a unix domain socket instead of a TCP port. All state lives under `~/.config/scrivener-companion/`. Each registered `.scriv` project gets its own `store.db` (replacing both `vectors.db` and the external `index.db`) containing chunks, embeddings, and document metadata. The Raycast extension interacts with the daemon exclusively through the socket — it never manages data directly.

## Config Directory

```
~/.config/scrivener-companion/
  server.lock        — flock advisory lock for single-instance enforcement
  server.pid         — PID of the running daemon (plain text, just the number)
  server.sock        — unix domain socket
  projects.json      — registry mapping .scriv paths to slugs
  store/
    my-novel-a3f2b1.db      — chunks, embeddings, document metadata
    other-book-8c4d2e.db    — one DB per registered project
```

### projects.json

Maps `.scriv` absolute paths to their slug (used as the DB filename):

```json
{
  "/Users/me/Documents/My Novel.scriv": "my-novel-a3f2b1",
  "/Users/me/Documents/Other Book.scriv": "other-book-8c4d2e"
}
```

The slug is `<basename-without-extension>-<first-6-chars-of-sha256-of-absolute-path>`. This is human-readable and collision-safe.

### store.db schema

Each project's `store.db` contains four tables:

```sql
-- Document metadata (replaces external index.db)
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
);

-- Text chunks
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_uuid TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL DEFAULT ''
);

-- Vector embeddings (sqlite-vec virtual table)
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[384]
);

-- Migration support for content_hash on existing DBs
-- (PRAGMA table_info check + ALTER TABLE if column missing)
```

The `document_index` table from the current implementation is replaced by the `documents` table — `modified_at` lives there now. The `documents` table is upserted during the ingest step alongside chunk operations.

## CLI Interface

The binary installs to `/usr/local/bin/scrivener-companion`.

```
scrivener-companion start     — daemonize and start serving
scrivener-companion stop      — graceful shutdown of running daemon
scrivener-companion restart   — stop + start
scrivener-companion status    — print current state
```

### start

1. Check if daemon is already running: try to acquire `flock` on `server.lock`. If lock is held, print "already running (PID <pid>)" and exit 1.
2. Fork a child process with `--serve` flag (the actual server mode), `detached: true`, `stdio: 'ignore'`.
3. The child:
   a. Acquires `flock` on `server.lock`.
   b. Cleans up stale `server.sock` if it exists from a previous crash.
   c. Writes `server.pid`.
   d. Creates `~/.config/scrivener-companion/` and `store/` directories if they don't exist.
   e. Loads ONNX model.
   f. Reads `projects.json`, indexes all registered projects (delta).
   g. Starts listening on `server.sock`.
4. The parent process exits 0 immediately after fork.

### stop

1. Read `server.pid`. If file doesn't exist, print "not running" and exit 0.
2. Check if PID is alive (`kill -0`). If dead, clean up stale `server.pid` and print "not running", exit 0.
3. Send `SIGTERM` to the PID.
4. Poll PID (up to 10 seconds) until it exits.
5. If still alive after timeout, send `SIGKILL`.
6. Clean up `server.pid` if the process didn't clean up after itself.

### restart

Run `stop` then `start`. If `stop` reports "not running", proceed with `start` anyway.

### status

1. Read `server.pid`. If file doesn't exist or PID is dead, print "stopped" and exit 0.
2. Try `GET /health` on `server.sock`.
3. If socket responds, print the state from the response (e.g. "running (ready)", "running (indexing)").
4. If socket doesn't respond (server is still starting up, model loading), print "running (starting)".

## Server Lifecycle

### State Machine

```
starting → indexing → ready → stopping
```

- **starting** — flock acquired, loading ONNX model.
- **indexing** — model loaded, running initial delta index pass on all registered projects.
- **ready** — listening on socket, accepting requests.
- **stopping** — received SIGTERM/SIGINT, closing connections, cleaning up.

### Startup Sequence

1. Acquire `flock` on `server.lock`. Fail → exit (another instance running).
2. Remove stale `server.sock` if it exists.
3. Write PID to `server.pid`.
4. Ensure `~/.config/scrivener-companion/store/` exists.
5. Read `WRITER_MEMORY_MODEL_DIR` env var (still required — points to ONNX model).
6. Load ONNX model (state: `starting`).
7. Read `projects.json`, delta-index all projects (state: `indexing`).
8. Start Fastify on `server.sock` (state: `ready`).

### Shutdown Sequence

1. Receive `SIGTERM` or `SIGINT` (state: `stopping`).
2. Close Fastify server (stop accepting new connections, finish in-flight requests).
3. Remove `server.sock`.
4. Remove `server.pid`.
5. Exit. OS releases flock automatically.

### Crash Recovery

- OS releases the `flock` when the process dies.
- Next `start` finds no lock held, cleans up stale `server.sock` and `server.pid`, starts fresh.

## HTTP API

All communication over unix domain socket at `~/.config/scrivener-companion/server.sock`.

### GET /health

Returns server state.

```json
{ "status": "ok", "state": "starting" | "indexing" | "ready" }
```

### POST /search

Semantic search across all registered projects. Unchanged from current implementation except metadata now comes from `documents` table in `store.db` instead of external `index.db`.

```json
// Request
{ "query": "string", "topK": 10 }

// Response
[
  {
    "chunk_text": "...",
    "document_uuid": "...",
    "title": "...",
    "binder_path": "...",
    "binder_section": "...",
    "deep_link": "...",
    "distance": 0.42,
    "project": "my-novel"
  }
]
```

### POST /index

Force re-index all registered projects. Unchanged behavior — delta logic still applies at chunk level even with force.

```json
// Response
{ "embedded": 42, "skipped": 100, "deleted": 3 }
```

### POST /projects

Register a new `.scriv` project.

```json
// Request
{ "path": "/absolute/path/to/project.scriv" }

// Response (201 Created)
{ "slug": "my-novel-a3f2b1", "path": "/absolute/path/to/project.scriv" }
```

On registration:
1. Validate the path exists and contains a `.scrivx` file.
2. Generate slug from basename + hash.
3. Add to `projects.json`.
4. Create `store/<slug>.db`.
5. Trigger initial index for this project.

Returns 409 if project is already registered.

### GET /projects

List all registered projects.

```json
// Response
[
  {
    "slug": "my-novel-a3f2b1",
    "path": "/absolute/path/to/project.scriv",
    "name": "My Novel"
  }
]
```

### DELETE /projects/:slug

Unregister a project and delete its data.

```json
// Response (200)
{ "slug": "my-novel-a3f2b1", "deleted": true }
```

Returns 404 if slug not found.

On deletion:
1. Remove from `projects.json`.
2. Delete `store/<slug>.db`.

## Delta Indexing

Unchanged from current implementation. On each index pass (startup or `POST /index`):

1. **walk** the `.scriv` bundle — discover documents with file paths and metadata.
2. **orphan cleanup** — documents in DB but not in `.scriv` get deleted.
3. **mtime check** — skip documents whose `modified_at` hasn't changed (uses `documents.modified_at`).
4. **parse** — read RTF, convert to text.
5. **chunk + hash** — split into 384-char chunks with 64-char overlap, SHA-256 each.
6. **diff chunks** — compare hashes against stored chunks. only re-embed changed chunks. delete trailing chunks if document got shorter.
7. **upsert metadata** — update the `documents` table with current title, binder path, labels, etc.

With `force=true` (from `POST /index`), step 3 is skipped but chunk-level hashing still applies.

## What Changes From Current Implementation

| Aspect | Before | After |
|--------|--------|-------|
| Transport | TCP localhost:52718 | Unix domain socket |
| Port config | Hardcoded | Not needed |
| Lifecycle | None — run and hope | CLI start/stop/restart/status |
| Single instance | None | flock on server.lock |
| Project config | `WRITER_MEMORY_SCRIV_PATH` env var | `projects.json` registry + API |
| Data location | `.memory/` next to each `.scriv` | `~/.config/scrivener-companion/store/` |
| Metadata | External `index.db` (Raycast-managed) | `documents` table in `store.db` |
| DB name | `vectors.db` | `<slug>.db` |
| Binary location | Not specified | `/usr/local/bin/scrivener-companion` |
| Process management | Manual | Daemonize with PID file |

## What Does Not Change

- Ingest pipeline (`src/ingest/`) — walk, parse, chunk, embed, store steps unchanged
- ONNX model — same model, same `WRITER_MEMORY_MODEL_DIR` env var
- Embedding dimensions — 384
- Chunk parameters — 384 chars, 64 overlap
- SEA build — still produces a single executable
- CI workflow — still builds macOS binaries on tag push
