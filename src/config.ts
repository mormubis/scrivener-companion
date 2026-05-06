import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".config", "scrivener-companion");
const STORE_DIR = path.join(CONFIG_DIR, "store");

export const paths = {
  configDir: CONFIG_DIR,
  storeDir: STORE_DIR,
  lock: path.join(CONFIG_DIR, "server.lock"),
  pid: path.join(CONFIG_DIR, "server.pid"),
  sock: path.join(CONFIG_DIR, "server.sock"),
  projects: path.join(CONFIG_DIR, "projects.json"),
} as const;

export function ensureDirs(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  slug: string;
  path: string;
  name: string;
  dbPath: string;
}

export function generateSlug(scrivPath: string): string {
  const absolutePath = path.resolve(scrivPath);
  const name = path.basename(absolutePath, ".scriv")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const hash = crypto
    .createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .slice(0, 6);
  return `${name}-${hash}`;
}

export function readRegistry(): Record<string, string> {
  if (!fs.existsSync(paths.projects)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(paths.projects, "utf-8"));
}

export function writeRegistry(registry: Record<string, string>): void {
  ensureDirs();
  fs.writeFileSync(paths.projects, JSON.stringify(registry, null, 2) + "\n");
}

export function listProjects(): ProjectEntry[] {
  const registry = readRegistry();
  return Object.entries(registry).map(([scrivPath, slug]) => ({
    slug,
    path: scrivPath,
    name: path.basename(scrivPath, ".scriv"),
    dbPath: path.join(STORE_DIR, `${slug}.db`),
  }));
}

export function addProject(scrivPath: string): ProjectEntry {
  const absolutePath = path.resolve(scrivPath);
  const registry = readRegistry();

  if (registry[absolutePath]) {
    throw new Error(`project already registered: ${absolutePath}`);
  }

  // Validate it's a .scriv bundle
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`path does not exist: ${absolutePath}`);
  }
  const entries = fs.readdirSync(absolutePath);
  if (!entries.some((e) => e.endsWith(".scrivx"))) {
    throw new Error(`no .scrivx file found in ${absolutePath}`);
  }

  const slug = generateSlug(absolutePath);
  registry[absolutePath] = slug;
  writeRegistry(registry);

  return {
    slug,
    path: absolutePath,
    name: path.basename(absolutePath, ".scriv"),
    dbPath: path.join(STORE_DIR, `${slug}.db`),
  };
}

export function removeProject(slug: string): ProjectEntry | null {
  const registry = readRegistry();
  const entry = Object.entries(registry).find(([, s]) => s === slug);
  if (!entry) return null;

  const [scrivPath] = entry;
  delete registry[scrivPath];
  writeRegistry(registry);

  const dbPath = path.join(STORE_DIR, `${slug}.db`);
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  return {
    slug,
    path: scrivPath,
    name: path.basename(scrivPath, ".scriv"),
    dbPath,
  };
}
