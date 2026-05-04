import path from "node:path";

/**
 * Build an x-scrivener-item deep link URL for a document.
 *
 * The format is: x-scrivener-item://<project-path>?id=<uuid>
 * This opens Scrivener and navigates to the specific document in the binder.
 */
export function buildDeepLink(scrivPath: string, documentUuid: string): string {
  const absolutePath = path.resolve(scrivPath);
  return `x-scrivener-item://${absolutePath}?id=${documentUuid}`;
}
