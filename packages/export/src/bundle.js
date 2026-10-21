import { open, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_BUNDLE_BYTES,
  MAX_SNAPSHOT_BYTES,
  SCHEMA_VERSION,
  canonicalJson,
  decodeUtf8,
  fail,
  isSha256,
  sha256,
  validateCollections,
  validateSnapshotBytes,
  validateWorkspace,
  verifyTextSelector,
} from "../../core/src/index.js";
import {
  loadWorkspace,
  readObject,
  replaceWorkspaceData,
  verifyWorkspace,
} from "../../storage/src/workspace.js";

export const BUNDLE_FORMAT = "claimlineage-bundle";
export const MAX_BUNDLE_ITEMS = 10_000;
export const MAX_BUNDLE_EVIDENCE_LINKS = 20_000;
export const MAX_VERIFICATION_WORK_BYTES = 256 * 1024 * 1024;

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_BUNDLE", `${label} must be an object.`);
  }
  return value;
}

function decodeBase64(value, digest) {
  const maximumEncodedLength = Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4;
  if (typeof value !== "string" || value.length > maximumEncodedLength || value.length % 4 !== 0) {
    fail("INVALID_BUNDLE", `Object ${digest} is not canonical base64.`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if ((padding === 2 && contentLength % 4 !== 2) || (padding === 1 && contentLength % 4 !== 3)) {
    fail("INVALID_BUNDLE", `Object ${digest} is not canonical base64.`);
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!valid) fail("INVALID_BUNDLE", `Object ${digest} is not canonical base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_SNAPSHOT_BYTES) fail("OBJECT_TOO_LARGE", `Bundle object ${digest} exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
  if (bytes.toString("base64") !== value) fail("INVALID_BUNDLE", `Object ${digest} is not canonical base64.`);
  return bytes;
}

export async function createBundle(root) {
  await verifyWorkspace(root);
  const state = await loadWorkspace(root);
  const objects = {};
  for (const digest of [...new Set(state.snapshots.map((item) => item.sha256))].sort()) {
    objects[digest] = (await readObject(state.place, digest)).toString("base64");
  }
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    workspace: state.workspace,
    snapshots: [...state.snapshots].sort((left, right) => left.id.localeCompare(right.id)),
    claims: [...state.claims].sort((left, right) => left.id.localeCompare(right.id)),
    objects,
  };
}

export function validateBundle(bundle) {
  plainObject(bundle, "bundle");
  const supportedFields = new Set(["format", "schemaVersion", "workspace", "snapshots", "claims", "objects"]);
  for (const key of Object.keys(bundle)) {
    if (!supportedFields.has(key)) fail("INVALID_BUNDLE", `bundle.${key} is not a supported field.`);
  }
  if (bundle.format !== BUNDLE_FORMAT) fail("INVALID_BUNDLE", `bundle.format must equal ${BUNDLE_FORMAT}.`);
  if (bundle.schemaVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `bundle.schemaVersion must equal ${SCHEMA_VERSION}.`);
  if (!Array.isArray(bundle.snapshots) || !Array.isArray(bundle.claims)) fail("INVALID_BUNDLE", "bundle.snapshots and bundle.claims must be arrays.");
  if (bundle.snapshots.length > MAX_BUNDLE_ITEMS || bundle.claims.length > MAX_BUNDLE_ITEMS) {
    fail("INVALID_BUNDLE", `Bundle snapshot and claim counts must not exceed ${MAX_BUNDLE_ITEMS}.`);
  }
  let evidenceLinks = 0;
  for (const claim of bundle.claims) {
    if (claim && typeof claim === "object" && Array.isArray(claim.evidence)) evidenceLinks += claim.evidence.length;
    if (evidenceLinks > MAX_BUNDLE_EVIDENCE_LINKS) {
      fail("VERIFICATION_WORK_LIMIT", `Bundle evidence links must not exceed ${MAX_BUNDLE_EVIDENCE_LINKS}.`);
    }
  }
  validateWorkspace(bundle.workspace);
  validateCollections(bundle.snapshots, bundle.claims);
  const encodedObjects = plainObject(bundle.objects, "bundle.objects");
  const objects = new Map();
  for (const [digest, encoded] of Object.entries(encodedObjects)) {
    if (!isSha256(digest)) fail("INVALID_BUNDLE", `Object key ${JSON.stringify(digest)} is not a SHA-256 digest.`);
    const bytes = decodeBase64(encoded, digest);
    if (sha256(bytes) !== digest) fail("OBJECT_HASH_MISMATCH", `Bundle object ${digest} failed SHA-256 verification.`);
    objects.set(digest, bytes);
  }
  const referenced = new Set();
  const snapshotsById = new Map();
  for (const snapshot of bundle.snapshots) {
    const bytes = objects.get(snapshot.sha256);
    if (!bytes) fail("MISSING_OBJECT", `Bundle object ${snapshot.sha256} is missing.`);
    validateSnapshotBytes(snapshot, bytes);
    referenced.add(snapshot.sha256);
    snapshotsById.set(snapshot.id, snapshot);
  }
  const selectorChecks = new Map();
  let verificationWork = 0;
  for (const claim of bundle.claims) {
    for (const evidence of claim.evidence) {
      const snapshot = snapshotsById.get(evidence.snapshotId);
      const key = `${snapshot.sha256}\n${canonicalJson(evidence.selector)}`;
      if (!selectorChecks.has(key)) {
        const bytes = objects.get(snapshot.sha256);
        verificationWork += bytes.length;
        if (verificationWork > MAX_VERIFICATION_WORK_BYTES) {
          fail("VERIFICATION_WORK_LIMIT", `Bundle selector verification exceeds ${MAX_VERIFICATION_WORK_BYTES} byte-checks.`);
        }
        selectorChecks.set(key, { bytes, selector: evidence.selector });
      }
    }
  }
  for (const { bytes, selector } of selectorChecks.values()) verifyTextSelector(bytes, selector);
  for (const digest of objects.keys()) {
    if (!referenced.has(digest)) fail("UNREFERENCED_OBJECT", `Bundle object ${digest} is not referenced by a snapshot.`);
  }
  return {
    valid: true,
    workspaceId: bundle.workspace.id,
    snapshots: bundle.snapshots.length,
    claims: bundle.claims.length,
    objects,
  };
}

export async function exportBundle(root, output) {
  const bundle = await createBundle(root);
  const bytes = Buffer.from(canonicalJson(bundle), "utf8");
  if (bytes.length > MAX_BUNDLE_BYTES) fail("BUNDLE_TOO_LARGE", `Evidence bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`);
  let handle;
  try {
    handle = await open(path.resolve(output), "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") fail("OUTPUT_EXISTS", `${path.resolve(output)} already exists; it was not changed.`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return { output: path.resolve(output), byteLength: bytes.length, sha256: sha256(bytes), bundle };
}

export async function readBundle(file) {
  const resolved = path.resolve(file);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") fail("MISSING_BUNDLE", `${resolved} does not exist.`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail("INVALID_BUNDLE_FILE", `${resolved} must be a regular file.`);
  if (info.size > MAX_BUNDLE_BYTES) fail("BUNDLE_TOO_LARGE", `${resolved} exceeds ${MAX_BUNDLE_BYTES} bytes.`);
  const bytes = await readFile(resolved);
  let bundle;
  try {
    bundle = JSON.parse(decodeUtf8(bytes, "evidence bundle"));
  } catch (error) {
    if (error.code === "INVALID_UTF8") throw error;
    fail("INVALID_BUNDLE", `${resolved} is not valid JSON: ${error.message}`);
  }
  const report = validateBundle(bundle);
  if (!bytes.equals(Buffer.from(canonicalJson(bundle), "utf8"))) {
    fail("NON_CANONICAL_BUNDLE", `${resolved} is not canonical ClaimLineage JSON.`);
  }
  return { resolved, bytes, bundle, report };
}

export async function verifyBundleFile(file) {
  const result = await readBundle(file);
  return {
    ...result.report,
    file: result.resolved,
    byteLength: result.bytes.length,
    sha256: sha256(result.bytes),
  };
}

export async function importBundle(file, destination) {
  const { bundle, report } = await readBundle(file);
  await replaceWorkspaceData(destination, {
    workspace: bundle.workspace,
    snapshots: bundle.snapshots,
    claims: bundle.claims,
    objects: report.objects,
  });
  return { root: path.resolve(destination), workspaceId: bundle.workspace.id };
}
