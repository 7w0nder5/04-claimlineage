import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importUpload } from "../packages/capture/src/file.js";
import { addClaim, initWorkspace, loadWorkspace } from "../packages/storage/src/workspace.js";
import { exportBundle, importBundle, validateBundle, verifyBundleFile } from "../packages/export/src/bundle.js";
import { sha256 } from "../packages/core/src/index.js";
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
