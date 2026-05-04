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

/**
 * Convert RTF content to plain text.
 *
 * Scrivener's RTF is relatively simple -- mostly text with formatting commands.
 * We strip all RTF control words and groups, keeping only the text content.
 */
export function rtfToText(rtf: string): string {
  let text = "";
  let i = 0;
  let skipGroup = false;
  const skipGroupStack: boolean[] = [];

  while (i < rtf.length) {
    const char = rtf[i];

    if (char === "{") {
      skipGroupStack.push(skipGroup);
      // Check if this group starts with a destination we should skip
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

      // Escaped special characters
      if (nextChar === "{" || nextChar === "}" || nextChar === "\\") {
        text += nextChar;
        i++;
        continue;
      }

      // Hex escape: \'xx (e.g. \'e9 = é)
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

      // Line breaks
      if (nextChar === "\n" || nextChar === "\r") {
        i++;
        continue;
      }

      // Read control word
      let controlWord = "";
      while (i < rtf.length && /[a-zA-Z]/.test(rtf[i])) {
        controlWord += rtf[i];
        i++;
      }

      // Read optional numeric parameter
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

      // Consume delimiter space
      if (i < rtf.length && rtf[i] === " ") {
        i++;
      }

      // Handle known control words
      if (controlWord === "par" || controlWord === "line") {
        text += "\n";
      } else if (controlWord === "tab") {
        text += "\t";
      } else if (controlWord === "u") {
        // Unicode character: \uN followed by a replacement char
        const codePoint = parseInt(param, 10);
        if (!isNaN(codePoint)) {
          text += String.fromCodePoint(
            codePoint < 0 ? codePoint + 65536 : codePoint,
          );
        }
        // Skip the replacement character
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

    // Plain text character
    text += char;
    i++;
  }

  // Clean up: collapse multiple newlines, trim
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
