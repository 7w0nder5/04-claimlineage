import path from "node:path";
import { addSnapshot, resolveImportFile } from "../../storage/src/workspace.js";

const MEDIA_TYPES = new Map([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".md", "text/markdown"],
  [".text", "text/plain"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export function mediaTypeForName(name) {
  return MEDIA_TYPES.get(path.extname(name).toLowerCase()) || "application/octet-stream";
}

export async function importFile(root, file, options = {}) {
  const { resolved, bytes } = await resolveImportFile(file);
  return addSnapshot(root, {
    bytes,
    mediaType: mediaTypeForName(resolved),
    source: { type: "file", label: path.basename(resolved) },
    localPath: resolved,
    ...options,
  });
}

export async function importUpload(root, { bytes, name, mediaType }, options = {}) {
  return addSnapshot(root, {
    bytes,
    mediaType: mediaType || mediaTypeForName(name),
    source: { type: "upload", label: path.basename(name || "upload.bin") },
    ...options,
  });
}
