import { XMLParser } from "fast-xml-parser";
import fs from "node:fs";
import path from "node:path";
import { rtfToText } from "./rtf.js";
import { buildDeepLink } from "./deep-links.js";

export interface BinderItem {
  uuid: string;
  title: string;
  type: string;
  children: BinderItem[];
}

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
  text: string;
  notesText: string | null;
  deepLink: string;
  modifiedAt: number;
}

export interface ScrivenerProject {
  binderTree: BinderItem[];
  documents: ParsedDocument[];
}

type ParsedXml = Record<string, unknown>;

// Types that represent top-level binder sections
const SECTION_TYPES = new Set(["DraftFolder", "ResearchFolder", "Folder"]);

// Types to skip entirely (trash and media)
const SKIP_TYPES = new Set(["TrashFolder", "PDF", "WebArchive"]);

// Types that can have text content
const TEXT_TYPES = new Set(["Text", "Folder", "DraftFolder", "ResearchFolder"]);

/**
 * Parse a .scriv project bundle and extract all documents with their text content.
 */
export function parseScrivProject(scrivPath: string): ScrivenerProject {
  // Find the .scrivx file inside the .scriv bundle
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

  // Build lookup tables
  const labelMap = buildLabelMap(parsed);
  const statusMap = buildStatusMap(parsed);
  const sectionTypeMap = buildSectionTypeMap(parsed);

  const documents: ParsedDocument[] = [];

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

      // Skip trash and media types entirely
      if (SKIP_TYPES.has(type)) {
        continue;
      }

      const binderPath = parentPath ? `${parentPath}/${title}` : title;

      // Determine the binder section for this item's children
      // Top-level items of section types become the section name for their subtree
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

      // Only process text-capable types
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

      const rtf = fs.readFileSync(contentPath, "utf-8");
      const text = rtfToText(rtf);

      if (text.length === 0) {
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

      // SectionType element may have a ChildDefault attribute; the text content is the item's own UUID
      const sectionTypeRaw = meta.SectionType;
      let sectionTypeUuid: string | null = null;
      if (sectionTypeRaw != null) {
        if (typeof sectionTypeRaw === "object") {
          // Has attributes; text content is in #text
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

      // Extract notes if present
      const notesPath = path.join(
        scrivPath,
        "Files",
        "Data",
        uuid,
        "notes.rtf",
      );
      let notesText: string | null = null;
      if (fs.existsSync(notesPath)) {
        const notesRtf = fs.readFileSync(notesPath, "utf-8");
        const parsedNotes = rtfToText(notesRtf);
        notesText = parsedNotes.length > 0 ? parsedNotes : null;
      }

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
        text,
        notesText,
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

/**
 * Render the binder tree as a readable string with indentation.
 */
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
