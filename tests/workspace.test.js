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
  replaceWorkspaceData,
  verifyWorkspace,
} from "../packages/storage/src/workspace.js";
import { sha256 } from "../packages/core/src/index.js";
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

test("workspace verification rejects corrupt and valid unreferenced objects", async (t) => {
  const corruptRoot = await temporaryDirectory(t);
  await initWorkspace(corruptRoot);
  const declared = sha256(Buffer.from("declared"));
  await writeFile(path.join(corruptRoot, ".claimlineage", "objects", declared), "different");
  await assert.rejects(() => verifyWorkspace(corruptRoot), (error) => error.code === "OBJECT_HASH_MISMATCH");

  const validRoot = await temporaryDirectory(t);
  await initWorkspace(validRoot);
  const bytes = Buffer.from("unreferenced");
  await writeFile(path.join(validRoot, ".claimlineage", "objects", sha256(bytes)), bytes);
  await assert.rejects(() => verifyWorkspace(validRoot), (error) => error.code === "ORPHAN_OBJECT");
});

test("snapshot journal recovers or rolls back every interrupted write stage", async (t) => {
  for (const step of ["journal", "object", "snapshots", "localSources"]) {
    const root = await temporaryDirectory(t, `claimlineage-${step}-`);
    await initWorkspace(root);
    await assert.rejects(
      () => addSnapshot(root, {
        bytes: Buffer.from(`bytes-${step}`),
        mediaType: "text/plain",
        source: { type: "upload", label: `${step}.txt` },
        onTransactionStep(current) {
          if (current === step) throw new Error(`interrupted after ${step}`);
        },
      }),
      new RegExp(`interrupted after ${step}`),
    );
    const state = await loadWorkspace(root);
    assert.equal(state.snapshots.length, step === "journal" ? 0 : 1, step);
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".claimlineage", "transaction.json")).then(() => true, () => false)), false);
    assert.equal((await verifyWorkspace(root)).valid, true);
  }
});

test("staged workspace import leaves no published partial workspace on write failure", async (t) => {
  const parent = await temporaryDirectory(t);
  const bytes = Buffer.from("portable");
  const digest = sha256(bytes);
  const data = {
    workspace: {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000001",
      name: "Staged import",
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    snapshots: [{
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000002",
      capturedAt: "2026-01-02T03:04:05.000Z",
      mediaType: "text/plain",
      byteLength: bytes.length,
      sha256: digest,
      source: { type: "upload", label: "portable.txt" },
    }],
    claims: [],
    objects: new Map([[digest, bytes]]),
  };
  for (const step of ["directories", "objects", "workspace", "snapshots", "claims", "localSources", "verified"]) {
    const destination = path.join(parent, step);
    await assert.rejects(
      () => replaceWorkspaceData(destination, data, { onImportStep(current) { if (current === step) throw new Error(step); } }),
      new RegExp(step),
    );
    assert.equal(await import("node:fs/promises").then(({ stat }) => stat(path.join(destination, ".claimlineage")).then(() => true, () => false)), false, step);
    await replaceWorkspaceData(destination, data);
    assert.equal((await verifyWorkspace(destination)).snapshots, 1);
  }
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
