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

const SECTION_TYPES = new Set(["DraftFolder", "ResearchFolder", "Folder"]);
const SKIP_TYPES = new Set(["TrashFolder", "PDF", "WebArchive"]);
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
