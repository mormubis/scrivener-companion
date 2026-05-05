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
