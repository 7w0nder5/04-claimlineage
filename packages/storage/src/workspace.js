import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_SNAPSHOT_BYTES,
  SCHEMA_VERSION,
  canonicalJson,
  createTextSelector,
  fail,
  isSha256,
  sha256,
  validateClaim,
  validateCollections,
  validateSnapshot,
  validateSnapshotBytes,
  validateTextSelector,
  validateWorkspace,
  verifyTextSelector,
} from "../../core/src/index.js";

const DATA_DIRECTORY = ".claimlineage";
const METADATA_LIMIT = 5 * 1024 * 1024;
const TRANSACTION_LIMIT = 12 * 1024 * 1024;

function locations(root) {
  const resolvedRoot = path.resolve(root);
  const data = path.join(resolvedRoot, DATA_DIRECTORY);
  return {
    root: resolvedRoot,
    data,
    workspace: path.join(data, "workspace.json"),
    snapshots: path.join(data, "snapshots.json"),
    claims: path.join(data, "claims.json"),
    localSources: path.join(data, "local-sources.json"),
    objects: path.join(data, "objects"),
    lock: path.join(data, "write.lock"),
    transaction: path.join(data, "transaction.json"),
  };
}

async function ensureRegularFile(file, label, maximum = METADATA_LIMIT) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") fail("MISSING_WORKSPACE_FILE", `${label} is missing.`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail("UNSAFE_WORKSPACE_FILE", `${label} must be a regular file, not a symbolic link.`);
  if (info.size > maximum) fail("METADATA_TOO_LARGE", `${label} exceeds ${maximum} bytes.`);
  return info;
}

async function ensureDirectory(directory, label) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") fail("MISSING_WORKSPACE", `${label} does not exist.`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("UNSAFE_WORKSPACE_DIRECTORY", `${label} must be a directory, not a symbolic link.`);
}

async function readJson(file, label, maximum = METADATA_LIMIT) {
  await ensureRegularFile(file, label, maximum);
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail("INVALID_JSON", `${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

async function recoverPendingSnapshotTransaction(place) {
  let pending;
  try {
    pending = await lstat(place.transaction);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (pending.isSymbolicLink() || !pending.isFile()) fail("UNSAFE_TRANSACTION", "transaction.json must be a regular file.");
  await withWriteLock(place, async () => {
    const transaction = await readJson(place.transaction, "transaction.json", TRANSACTION_LIMIT);
    if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction) || Object.getPrototypeOf(transaction) !== Object.prototype) {
      fail("INVALID_TRANSACTION", "transaction.json must contain an object.");
    }
    const keys = Object.keys(transaction).sort();
    if (keys.join("\n") !== ["kind", "localSources", "objectDigest", "objectExisted", "schemaVersion", "snapshots"].sort().join("\n")
      || transaction.schemaVersion !== SCHEMA_VERSION
      || transaction.kind !== "snapshot-metadata"
      || !isSha256(transaction.objectDigest)
      || typeof transaction.objectExisted !== "boolean") {
      fail("INVALID_TRANSACTION", "transaction.json has an unsupported structure.");
    }
    const claims = await readJson(place.claims, "claims.json");
    validateCollections(transaction.snapshots, claims);
    validateLocalSources(transaction.localSources, new Set(transaction.snapshots.map((item) => item.id)));

    let objectFailure;
    for (const snapshot of transaction.snapshots) {
      try {
        const bytes = await readObject(place, snapshot.sha256);
        validateSnapshotBytes(snapshot, bytes);
      } catch (error) {
        if (!["MISSING_OBJECT", "OBJECT_SIZE_MISMATCH", "OBJECT_HASH_MISMATCH", "OBJECT_TOO_LARGE"].includes(error.code)) throw error;
        objectFailure = error;
        break;
      }
    }
    if (objectFailure) {
      const currentSnapshots = await readJson(place.snapshots, "snapshots.json");
      if (canonicalJson(currentSnapshots) === canonicalJson(transaction.snapshots)) {
        fail("INCOMPLETE_TRANSACTION", `Committed snapshot metadata cannot be recovered: ${objectFailure.message}`);
      }
      if (!transaction.objectExisted) await rm(path.join(place.objects, transaction.objectDigest), { force: true });
      await rm(place.transaction);
      return;
    }
    await atomicWriteJson(place.snapshots, transaction.snapshots);
    await atomicWriteJson(place.localSources, transaction.localSources);
    await rm(place.transaction);
  });
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function withWriteLock(place, operation) {
  let handle;
  try {
    handle = await open(place.lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") fail("WORKSPACE_LOCKED", `Another write is active. If no process is writing, remove ${place.lock}.`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(place.lock, { force: true }).catch(() => {});
  }
}

function validateLocalSources(value, snapshotIds) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_DATA", "local-sources.json must contain an object.");
  }
  for (const [id, sourcePath] of Object.entries(value)) {
    if (!snapshotIds.has(id)) fail("INVALID_DATA", `local-sources.json contains unknown snapshot id ${id}.`);
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) fail("INVALID_DATA", `The local source for ${id} must be an absolute path.`);
  }
  return value;
}

export async function initWorkspace(root, { name, idFactory = randomUUID, now = () => new Date() } = {}) {
  const place = locations(root);
  await mkdir(place.root, { recursive: true });
  const workspace = {
    schemaVersion: SCHEMA_VERSION,
    id: idFactory(),
    name: name?.trim() || path.basename(place.root),
    createdAt: now().toISOString(),
  };
  validateWorkspace(workspace);
  await replaceWorkspaceData(place.root, { workspace, snapshots: [], claims: [], objects: new Map() });
  return { root: place.root, workspace };
}

export async function loadWorkspace(root) {
  const place = locations(root);
  await ensureDirectory(place.data, place.data);
  await ensureDirectory(place.objects, "workspace objects directory");
  await recoverPendingSnapshotTransaction(place);
  const [workspace, snapshots, claims, localSources] = await Promise.all([
    readJson(place.workspace, "workspace.json"),
    readJson(place.snapshots, "snapshots.json"),
    readJson(place.claims, "claims.json"),
    readJson(place.localSources, "local-sources.json"),
  ]);
  validateWorkspace(workspace);
  validateCollections(snapshots, claims);
  validateLocalSources(localSources, new Set(snapshots.map((item) => item.id)));
  return { place, workspace, snapshots, claims, localSources };
}

async function writeObject(place, digest, bytes, { onObjectWriteStep = async () => {} } = {}) {
  const target = path.join(place.objects, digest);
  let handle;
  let created = false;
  try {
    handle = await open(target, "wx", 0o600);
    created = true;
    await onObjectWriteStep("opened");
    await handle.writeFile(bytes);
    await onObjectWriteStep("written");
    await handle.sync();
    await onObjectWriteStep("synced");
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
    if (error.code !== "EEXIST") throw error;
    const existing = await readObject(place, digest);
    if (sha256(existing) !== digest) fail("OBJECT_HASH_MISMATCH", `Existing object ${digest} is corrupt.`);
  }
}

export async function readObject(placeOrRoot, digest) {
  if (!isSha256(digest)) fail("INVALID_DIGEST", "Object digest must be 64 lowercase hexadecimal characters.");
  const place = typeof placeOrRoot === "string" ? locations(placeOrRoot) : placeOrRoot;
  const target = path.join(place.objects, digest);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") fail("MISSING_OBJECT", `Object ${digest} is missing.`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail("UNSAFE_OBJECT", `Object ${digest} must be a regular file.`);
  if (info.size > MAX_SNAPSHOT_BYTES) fail("OBJECT_TOO_LARGE", `Object ${digest} exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  return readFile(target);
}

function relativeSourcePath(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

export async function addSnapshot(root, {
  bytes,
  mediaType,
  source,
  localPath,
  idFactory = randomUUID,
  now = () => new Date(),
  onTransactionStep = async () => {},
  onObjectWriteStep = async () => {},
}) {
  if (!Buffer.isBuffer(bytes)) fail("INVALID_BYTES", "Snapshot content must be a Buffer.");
  if (bytes.length > MAX_SNAPSHOT_BYTES) fail("SNAPSHOT_TOO_LARGE", `Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  const state = await loadWorkspace(root);
  const digest = sha256(bytes);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    id: idFactory(),
    capturedAt: now().toISOString(),
    mediaType,
    byteLength: bytes.length,
    sha256: digest,
    source: { ...source },
  };
  if (source.type === "file" && localPath) {
    const relativePath = relativeSourcePath(await realpath(state.place.root), localPath);
    if (relativePath) snapshot.source.relativePath = relativePath;
  }
  validateSnapshot(snapshot);
  await withWriteLock(state.place, async () => {
    const current = await loadWorkspace(root);
    if (current.snapshots.some((item) => item.id === snapshot.id)) fail("DUPLICATE_ID", `Snapshot id ${snapshot.id} already exists.`);
    const nextSnapshots = [...current.snapshots, snapshot].sort((left, right) => left.id.localeCompare(right.id));
    const nextLocalSources = { ...current.localSources };
    if (localPath) nextLocalSources[snapshot.id] = localPath;
    const objectPath = path.join(current.place.objects, digest);
    let objectExisted;
    try {
      await lstat(objectPath);
      objectExisted = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      objectExisted = false;
    }
    await atomicWriteJson(current.place.transaction, {
      schemaVersion: SCHEMA_VERSION,
      kind: "snapshot-metadata",
      snapshots: nextSnapshots,
      localSources: nextLocalSources,
      objectDigest: digest,
      objectExisted,
    });
    await onTransactionStep("journal");
    await writeObject(current.place, digest, bytes, { onObjectWriteStep });
    await onTransactionStep("object");
    await atomicWriteJson(current.place.snapshots, nextSnapshots);
    await onTransactionStep("snapshots");
    await atomicWriteJson(current.place.localSources, nextLocalSources);
    await onTransactionStep("localSources");
    await rm(current.place.transaction);
  });
  return snapshot;
}

export async function addClaim(root, {
  statement,
  snapshotId,
  quote,
  idFactory = randomUUID,
  now = () => new Date(),
}) {
  const state = await loadWorkspace(root);
  const snapshot = state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) fail("MISSING_SNAPSHOT", `Snapshot ${snapshotId} does not exist.`);
  const bytes = await readObject(state.place, snapshot.sha256);
  validateSnapshotBytes(snapshot, bytes);
  const claim = {
    schemaVersion: SCHEMA_VERSION,
    id: idFactory(),
    statement,
    createdAt: now().toISOString(),
    evidence: [{ snapshotId, selector: createTextSelector(bytes, quote) }],
  };
  validateClaim(claim);
  await withWriteLock(state.place, async () => {
    const current = await loadWorkspace(root);
    if (!current.snapshots.some((item) => item.id === snapshotId)) fail("MISSING_SNAPSHOT", `Snapshot ${snapshotId} no longer exists.`);
    if (current.claims.some((item) => item.id === claim.id)) fail("DUPLICATE_ID", `Claim id ${claim.id} already exists.`);
    current.claims.push(claim);
    current.claims.sort((left, right) => left.id.localeCompare(right.id));
    await atomicWriteJson(current.place.claims, current.claims);
  });
  return claim;
}

export async function verifyWorkspace(root) {
  const state = await loadWorkspace(root);
  const referenced = new Set();
  const objectBytes = new Map();
  for (const snapshot of state.snapshots) {
    let bytes = objectBytes.get(snapshot.sha256);
    if (!bytes) {
      bytes = await readObject(state.place, snapshot.sha256);
      objectBytes.set(snapshot.sha256, bytes);
    }
    validateSnapshotBytes(snapshot, bytes);
    referenced.add(snapshot.sha256);
  }
  const snapshotsById = new Map(state.snapshots.map((item) => [item.id, item]));
  const verifiedSelectors = new Set();
  for (const claim of state.claims) {
    for (const evidence of claim.evidence) {
      const snapshot = snapshotsById.get(evidence.snapshotId);
      const selectorKey = `${snapshot.sha256}\n${canonicalJson(evidence.selector)}`;
      if (!verifiedSelectors.has(selectorKey)) {
        verifyTextSelector(objectBytes.get(snapshot.sha256), evidence.selector);
        verifiedSelectors.add(selectorKey);
      }
    }
  }
  const entries = await readdir(state.place.objects, { withFileTypes: true });
  const orphanObjects = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !isSha256(entry.name)) fail("UNSAFE_OBJECT", `Unexpected object entry ${entry.name}.`);
    if (!referenced.has(entry.name)) {
      const bytes = await readObject(state.place, entry.name);
      if (sha256(bytes) !== entry.name) fail("OBJECT_HASH_MISMATCH", `Unreferenced object ${entry.name} failed SHA-256 verification.`);
      orphanObjects.push(entry.name);
    }
  }
  if (orphanObjects.length) fail("ORPHAN_OBJECT", `Workspace contains ${orphanObjects.length} unreferenced object(s).`, { orphanObjects: orphanObjects.sort() });
  return {
    valid: true,
    workspaceId: state.workspace.id,
    snapshots: state.snapshots.length,
    claims: state.claims.length,
    objects: referenced.size,
  };
}

export async function currentSourceBytes(root, snapshotId) {
  const state = await loadWorkspace(root);
  const snapshot = state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) fail("MISSING_SNAPSHOT", `Snapshot ${snapshotId} does not exist.`);
  if (snapshot.source.type !== "file") return { snapshot, bytes: null, status: "unsupported" };
  const sourcePath = state.localSources[snapshotId];
  if (!sourcePath) return { snapshot, bytes: null, status: "unavailable" };
  let info;
  try {
    info = await stat(sourcePath);
  } catch (error) {
    if (error.code === "ENOENT") return { snapshot, bytes: null, status: "unavailable" };
    throw error;
  }
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return { snapshot, bytes: null, status: "unavailable" };
  const bytes = await readFile(sourcePath);
  return { snapshot, bytes, status: sha256(bytes) === snapshot.sha256 ? "unchanged" : "changed" };
}

export async function replaceWorkspaceData(root, { workspace, snapshots, claims, objects }, { onImportStep = async () => {} } = {}) {
  validateWorkspace(workspace);
  validateCollections(snapshots, claims);
  const place = locations(root);
  await mkdir(place.root, { recursive: true });
  try {
    await lstat(place.data);
    fail("WORKSPACE_EXISTS", `${place.data} already exists; it was not changed.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stagingRoot = path.join(place.root, `.claimlineage-import-${randomUUID()}`);
  const stagingPlace = locations(stagingRoot);
  try {
    await mkdir(stagingPlace.data, { recursive: true, mode: 0o700 });
    await mkdir(stagingPlace.objects, { mode: 0o700 });
    await onImportStep("directories");
    for (const snapshot of snapshots) {
      const bytes = objects.get(snapshot.sha256);
      if (!bytes) fail("MISSING_OBJECT", `Bundle object ${snapshot.sha256} is missing.`);
      validateSnapshotBytes(snapshot, bytes);
      await writeObject(stagingPlace, snapshot.sha256, bytes);
    }
    await onImportStep("objects");
    await atomicWriteJson(stagingPlace.workspace, workspace);
    await onImportStep("workspace");
    await atomicWriteJson(stagingPlace.snapshots, [...snapshots].sort((left, right) => left.id.localeCompare(right.id)));
    await onImportStep("snapshots");
    await atomicWriteJson(stagingPlace.claims, [...claims].sort((left, right) => left.id.localeCompare(right.id)));
    await onImportStep("claims");
    await atomicWriteJson(stagingPlace.localSources, {});
    await onImportStep("localSources");
    await verifyWorkspace(stagingRoot);
    await onImportStep("verified");
    await rename(stagingPlace.data, place.data);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(stagingRoot, { recursive: true, force: true });
  await verifyWorkspace(root);
  return { root: place.root, workspace };
}

export async function resolveImportFile(file) {
  const resolved = await realpath(file);
  const info = await stat(resolved);
  if (!info.isFile()) fail("INVALID_SOURCE_FILE", `${file} must resolve to a regular file.`);
  if (info.size > MAX_SNAPSHOT_BYTES) fail("SNAPSHOT_TOO_LARGE", `${file} exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  return { resolved, bytes: await readFile(resolved) };
}
