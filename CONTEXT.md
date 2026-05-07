# Scrivener Companion

Sidecar daemon for the Writer's Memory Raycast extension. Provides semantic search over Scrivener writing projects.

## Known Limitations

- **`node:sqlite` + `sqlite-vec` incompatibility** — `node:sqlite`'s `DatabaseSync` can't bind parameters to `sqlite-vec` virtual tables (`vec0`). prepared statements fail with "Only integers are allowed for primary key values". this forces us to use `better-sqlite3` instead of the built-in module, which adds a native addon dependency and complicates the SEA build. revisit when `node:sqlite` or `sqlite-vec` ships a fix.
