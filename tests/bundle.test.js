import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importUpload } from "../packages/capture/src/file.js";
import { addClaim, initWorkspace, loadWorkspace } from "../packages/storage/src/workspace.js";
import {
  BUNDLE_FORMAT,
  MAX_BUNDLE_EVIDENCE_LINKS,
  MAX_BUNDLE_ITEMS,
  MAX_VERIFICATION_WORK_BYTES,
  exportBundle,
  importBundle,
  validateBundle,
  verifyBundleFile,
} from "../packages/export/src/bundle.js";
import { createTextSelector, sha256 } from "../packages/core/src/index.js";
import { temporaryDirectory } from "./helpers.js";

async function populatedWorkspace(t) {
  const root = await temporaryDirectory(t);
  await initWorkspace(root, { name: "Portable evidence" });
  const snapshot = await importUpload(root, { bytes: Buffer.from("A durable source sentence.\n"), name: "source.txt" });
  await addClaim(root, { statement: "The source is durable.", snapshotId: snapshot.id, quote: "durable source sentence" });
  return root;
}

test("bundle export is byte-for-byte deterministic", async (t) => {
  const root = await populatedWorkspace(t);
  const first = path.join(await temporaryDirectory(t), "first.clb");
  const second = path.join(await temporaryDirectory(t), "second.clb");
  const one = await exportBundle(root, first);
  const two = await exportBundle(root, second);
  assert.equal(one.sha256, two.sha256);
  assert.deepEqual(await readFile(first), await readFile(second));
});

test("bundle verification reports content and digest", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "evidence.clb");
  await exportBundle(root, file);
  const report = await verifyBundleFile(file);
  assert.equal(report.valid, true);
  assert.equal(report.snapshots, 1);
  assert.equal(report.claims, 1);
  assert.equal(report.sha256, sha256(await readFile(file)));
});

test("bundle export refuses to overwrite an existing path", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "existing.clb");
  await writeFile(file, "keep");
  await assert.rejects(() => exportBundle(root, file), (error) => error.code === "OUTPUT_EXISTS");
  assert.equal(await readFile(file, "utf8"), "keep");
});

test("bundle verification rejects modified object bytes", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "valid.clb");
  await exportBundle(root, file);
  const bundle = JSON.parse(await readFile(file, "utf8"));
  const digest = Object.keys(bundle.objects)[0];
  bundle.objects[digest] = Buffer.from("tampered").toString("base64");
  assert.throws(() => validateBundle(bundle), (error) => error.code === "OBJECT_HASH_MISMATCH");
});

test("bundle verification rejects extra objects", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "valid.clb");
  await exportBundle(root, file);
  const bundle = JSON.parse(await readFile(file, "utf8"));
  bundle.objects[sha256(Buffer.from("extra"))] = Buffer.from("extra").toString("base64");
  assert.throws(() => validateBundle(bundle), (error) => error.code === "UNREFERENCED_OBJECT");
});

test("bundle verification rejects undocumented top-level fields", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "valid.clb");
  await exportBundle(root, file);
  const bundle = JSON.parse(await readFile(file, "utf8"));
  bundle.localPath = "must-not-pass";
  assert.throws(() => validateBundle(bundle), /localPath is not a supported field/);
});

test("bundle reader rejects malformed UTF-8, duplicate keys, and non-canonical JSON", async (t) => {
  const folder = await temporaryDirectory(t);
  const malformed = path.join(folder, "malformed.clb");
  await writeFile(malformed, Buffer.from([0xff]));
  await assert.rejects(() => verifyBundleFile(malformed), (error) => error.code === "INVALID_UTF8");

  const root = await populatedWorkspace(t);
  const valid = path.join(folder, "valid.clb");
  await exportBundle(root, valid);
  const text = await readFile(valid, "utf8");
  const duplicate = path.join(folder, "duplicate.clb");
  await writeFile(duplicate, text.replace('"format": "claimlineage-bundle"', '"format": "wrong",\n  "format": "claimlineage-bundle"'));
  await assert.rejects(() => verifyBundleFile(duplicate), (error) => error.code === "NON_CANONICAL_BUNDLE");
  const minified = path.join(folder, "minified.clb");
  await writeFile(minified, JSON.stringify(JSON.parse(text)));
  await assert.rejects(() => verifyBundleFile(minified), (error) => error.code === "NON_CANONICAL_BUNDLE");
});

test("bundle rejects excessive evidence count before deep record validation", () => {
  const bundle = {
    format: BUNDLE_FORMAT,
    schemaVersion: 1,
    workspace: {},
    snapshots: [],
    claims: [{ evidence: new Array(MAX_BUNDLE_EVIDENCE_LINKS + 1).fill(null) }],
    objects: {},
  };
  assert.throws(() => validateBundle(bundle), (error) => error.code === "VERIFICATION_WORK_LIMIT");
});

test("bundle bounds unique selector verification work before scanning snapshots", () => {
  const bytes = Buffer.alloc(10 * 1024 * 1024, 0x78);
  const digest = sha256(bytes);
  const snapshotId = "00000000-0000-4000-8000-000000000002";
  const checks = Math.floor(MAX_VERIFICATION_WORK_BYTES / bytes.length) + 1;
  const claims = Array.from({ length: checks }, (_, index) => ({
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    statement: `Claim ${index}`,
    createdAt: "2026-01-02T03:04:05.000Z",
    evidence: [{
      snapshotId,
      selector: { type: "TextQuoteSelector", exact: "x", prefix: String(index), suffix: "", startByte: 0, endByte: 1 },
    }],
  }));
  const bundle = {
    format: BUNDLE_FORMAT,
    schemaVersion: 1,
    workspace: {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000001",
      name: "Work bound",
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    snapshots: [{
      schemaVersion: 1,
      id: snapshotId,
      capturedAt: "2026-01-02T03:04:05.000Z",
      mediaType: "text/plain",
      byteLength: bytes.length,
      sha256: digest,
      source: { type: "upload", label: "large.txt" },
    }],
    claims,
    objects: { [digest]: bytes.toString("base64") },
  };
  assert.throws(() => validateBundle(bundle), (error) => error.code === "VERIFICATION_WORK_LIMIT");
});

test("bundle round-trip preserves workspace data and bytes", async (t) => {
  const root = await populatedWorkspace(t);
  const folder = await temporaryDirectory(t);
  const first = path.join(folder, "first.clb");
  const second = path.join(folder, "second.clb");
  const restored = path.join(folder, "restored");
  await exportBundle(root, first);
  await importBundle(first, restored);
  await exportBundle(restored, second);
  assert.deepEqual(await readFile(first), await readFile(second));
  const state = await loadWorkspace(restored);
  assert.deepEqual(state.localSources, {});
});

test("bundle import refuses a destination that already contains workspace data", async (t) => {
  const root = await populatedWorkspace(t);
  const file = path.join(await temporaryDirectory(t), "source.clb");
  await exportBundle(root, file);
  await assert.rejects(() => importBundle(file, root), (error) => error.code === "WORKSPACE_EXISTS");
});

test("export refuses a workspace above the shared item-count contract", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const stored = await importUpload(root, { bytes: Buffer.from("x"), name: "x.txt" });
  const snapshots = Array.from({ length: MAX_BUNDLE_ITEMS + 1 }, (_, index) => ({
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    capturedAt: "2026-01-02T03:04:05.000Z",
    mediaType: "text/plain",
    byteLength: 1,
    sha256: stored.sha256,
    source: { type: "upload", label: "x.txt" },
  }));
  await writeFile(path.join(root, ".claimlineage", "snapshots.json"), JSON.stringify(snapshots));
  const output = path.join(await temporaryDirectory(t), "too-many.clb");
  await assert.rejects(() => exportBundle(root, output), /must not exceed/);
  await assert.rejects(() => readFile(output), (error) => error.code === "ENOENT");
});

test("export refuses a workspace above the shared evidence-link contract", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const stored = await importUpload(root, { bytes: Buffer.from("x"), name: "x.txt" });
  const selector = { type: "TextQuoteSelector", exact: "x", prefix: "", suffix: "", startByte: 0, endByte: 1 };
  const claimCount = Math.floor(MAX_BUNDLE_EVIDENCE_LINKS / 100) + 1;
  const claims = Array.from({ length: claimCount }, (_, index) => ({
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    statement: `Claim ${index}`,
    createdAt: "2026-01-02T03:04:05.000Z",
    evidence: Array.from({ length: 100 }, () => ({ snapshotId: stored.id, selector })),
  }));
  await writeFile(path.join(root, ".claimlineage", "claims.json"), JSON.stringify(claims));
  const output = path.join(await temporaryDirectory(t), "too-many-links.clb");
  await assert.rejects(() => exportBundle(root, output), (error) => error.code === "VERIFICATION_WORK_LIMIT");
  await assert.rejects(() => readFile(output), (error) => error.code === "ENOENT");
});

test("export refuses a workspace above the shared selector-work contract", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const markers = Array.from({ length: Math.floor(MAX_VERIFICATION_WORK_BYTES / (10 * 1024 * 1024)) + 1 }, (_, index) => `unique-marker-${String(index).padStart(2, "0")}`);
  const header = Buffer.from(markers.join("\n"));
  const bytes = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length, 0x78)]);
  const stored = await importUpload(root, { bytes, name: "large.txt" });
  const claims = markers.map((marker, index) => ({
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, "0")}`,
    statement: `Claim ${index}`,
    createdAt: "2026-01-02T03:04:05.000Z",
    evidence: [{ snapshotId: stored.id, selector: createTextSelector(bytes, marker) }],
  }));
  await writeFile(path.join(root, ".claimlineage", "claims.json"), JSON.stringify(claims));
  const output = path.join(await temporaryDirectory(t), "too-much-work.clb");
  await assert.rejects(() => exportBundle(root, output), (error) => error.code === "VERIFICATION_WORK_LIMIT");
  await assert.rejects(() => readFile(output), (error) => error.code === "ENOENT");
});
