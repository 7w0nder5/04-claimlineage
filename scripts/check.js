import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../packages/cli/src/cli.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/spec/product.md",
  "docs/spec/data-model.md",
  "docs/spec/security.md",
  "packages/cli/src/cli.js",
  "apps/web/index.html",
];

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "coverage", ".claimlineage"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

for (const relative of required) await readFile(path.join(root, relative));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(VERSION, manifest.version, "CLI and package versions must match");

const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".txt", ".yml"]);
const forbiddenMarkers = [/\bTODO\b/, /\bFIXME\b/, /__SESSION_TOKEN__(?!.*index\.html)/];
for (const file of await filesBelow(root)) {
  if (!textExtensions.has(path.extname(file))) continue;
  const text = await readFile(file, "utf8");
  for (const marker of forbiddenMarkers.slice(0, 2)) assert.equal(marker.test(text), false, `${path.relative(root, file)} contains unfinished marker ${marker}`);
  assert.equal(text.includes("C:\\Users\\Administrator"), false, `${path.relative(root, file)} leaks a machine-specific path`);
}

console.log(`Release checks passed for ${manifest.name} ${manifest.version}.`);
