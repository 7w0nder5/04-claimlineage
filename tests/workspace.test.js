import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importFile, importUpload, mediaTypeForName } from "../packages/capture/src/file.js";
import {
  addClaim,
  addSnapshot,
  currentSourceBytes,
  initWorkspace,
  loadWorkspace,
  verifyWorkspace,
} from "../packages/storage/src/workspace.js";
import { fixedIdentity, temporaryDirectory } from "./helpers.js";

test("workspace initialization creates the exact private data layout", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, "research");
  const identity = fixedIdentity();
  const result = await initWorkspace(root, { name: "Research", ...identity });
  assert.equal(result.workspace.name, "Research");
  const state = await loadWorkspace(root);
  assert.deepEqual(state.snapshots, []);
  assert.deepEqual(state.claims, []);
  assert.deepEqual(state.localSources, {});
  await assert.rejects(() => initWorkspace(root), (error) => error.code === "WORKSPACE_EXISTS");
});

test("file import, exact claim, and full verification form one working lineage", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, "workspace");
  const source = path.join(root, "source.txt");
  await mkdir(root);
  await writeFile(source, "First fact. Second fact.\n");
  await initWorkspace(root);
  const snapshot = await importFile(root, source);
  assert.equal(snapshot.source.relativePath, "source.txt");
  const claim = await addClaim(root, { statement: "The second fact is recorded.", snapshotId: snapshot.id, quote: "Second fact." });
  assert.equal(claim.evidence[0].selector.exact, "Second fact.");
  const report = await verifyWorkspace(root);
  assert.deepEqual({ snapshots: report.snapshots, claims: report.claims, objects: report.objects }, { snapshots: 1, claims: 1, objects: 1 });
});

test("equal bytes share an immutable object while snapshots remain distinct", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const first = await importUpload(root, { bytes: Buffer.from("same"), name: "a.txt" });
  const second = await importUpload(root, { bytes: Buffer.from("same"), name: "b.txt" });
  assert.notEqual(first.id, second.id);
  assert.equal(first.sha256, second.sha256);
  const report = await verifyWorkspace(root);
  assert.equal(report.objects, 1);
});

test("source drift reports unchanged, changed, and unavailable", async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  await writeFile(source, "original");
  await initWorkspace(root);
  const snapshot = await importFile(root, source);
  assert.equal((await currentSourceBytes(root, snapshot.id)).status, "unchanged");
  await writeFile(source, "changed");
  assert.equal((await currentSourceBytes(root, snapshot.id)).status, "changed");
  await chmod(source, 0o600);
  await import("node:fs/promises").then(({ rm }) => rm(source));
  assert.equal((await currentSourceBytes(root, snapshot.id)).status, "unavailable");
});

test("workspace verification detects object tampering and unexpected entries", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const snapshot = await importUpload(root, { bytes: Buffer.from("safe"), name: "safe.txt" });
  await writeFile(path.join(root, ".claimlineage", "objects", snapshot.sha256), "unsafe");
  await assert.rejects(() => verifyWorkspace(root), (error) => error.code === "OBJECT_SIZE_MISMATCH");

  const other = await temporaryDirectory(t);
  await initWorkspace(other);
  await writeFile(path.join(other, ".claimlineage", "objects", "unexpected"), "x");
  await assert.rejects(() => verifyWorkspace(other), (error) => error.code === "UNSAFE_OBJECT");
});

test("write lock prevents concurrent metadata mutation", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  await writeFile(path.join(root, ".claimlineage", "write.lock"), "busy\n");
  await assert.rejects(
    () => addSnapshot(root, { bytes: Buffer.from("x"), mediaType: "text/plain", source: { type: "upload", label: "x.txt" } }),
    (error) => error.code === "WORKSPACE_LOCKED",
  );
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, ".claimlineage", "objects"))), []);
});

test("metadata parser rejects symbolic metadata files where supported", async (t) => {
  const root = await temporaryDirectory(t);
  await initWorkspace(root);
  const target = path.join(root, "outside.json");
  await writeFile(target, "[]\n");
  const snapshots = path.join(root, ".claimlineage", "snapshots.json");
  const { rm, symlink } = await import("node:fs/promises");
  await rm(snapshots);
  try {
    await symlink(target, snapshots, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(() => loadWorkspace(root), (error) => error.code === "UNSAFE_WORKSPACE_FILE");
});

test("file media types are explicit and unknown extensions stay binary", () => {
  assert.equal(mediaTypeForName("DATA.CSV"), "text/csv");
  assert.equal(mediaTypeForName("archive.bin"), "application/octet-stream");
});

test("absolute local paths remain outside exported metadata collections", async (t) => {
  const root = await temporaryDirectory(t);
  const external = path.join(await temporaryDirectory(t), "external.txt");
  await writeFile(external, "external");
  await initWorkspace(root);
  const snapshot = await importFile(root, external);
  const publicMetadata = await readFile(path.join(root, ".claimlineage", "snapshots.json"), "utf8");
  assert.equal(snapshot.source.relativePath, undefined);
  assert.equal(publicMetadata.includes(external), false);
});
