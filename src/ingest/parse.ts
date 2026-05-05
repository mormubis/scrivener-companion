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
