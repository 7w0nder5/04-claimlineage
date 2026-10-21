import { TextDecoder } from "node:util";
import { fail } from "./errors.js";
import { isSha256, sha256 } from "./hash.js";

export const SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_QUOTE_CHARACTERS = 4000;
export const MAX_STATEMENT_CHARACTERS = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_DATA", `${path} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("INVALID_DATA", `${path}.${key} is not a supported field.`);
  }
}

function nonEmptyString(value, path, maximum = 10_000) {
  if (typeof value !== "string" || value.trim() === "" || [...value].length > maximum) {
    fail("INVALID_DATA", `${path} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("INVALID_DATA", `${path} must be an ISO 8601 UTC timestamp.`);
  }
  return value;
}

function uuid(value, path) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail("INVALID_DATA", `${path} must be a UUID.`);
  return value;
}

function integer(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_DATA", `${path} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function decodeUtf8(bytes, label = "snapshot") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8", `${label} is not valid UTF-8 text.`);
  }
}

function contextBefore(text, index, count = 32) {
  return [...text.slice(0, index)].slice(-count).join("");
}

function contextAfter(text, index, count = 32) {
  return [...text.slice(index)].slice(0, count).join("");
}

function byteOrderMarkLength(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

export function createTextSelector(bytes, exact) {
  nonEmptyString(exact, "quote", MAX_QUOTE_CHARACTERS);
  const text = decodeUtf8(bytes);
  const start = text.indexOf(exact);
  if (start === -1) fail("QUOTE_NOT_FOUND", "The exact quote does not occur in the snapshot.");
  if (text.indexOf(exact, start + 1) !== -1) {
    fail("QUOTE_AMBIGUOUS", "The exact quote occurs more than once; include more surrounding text.");
  }
  const startByte = byteOrderMarkLength(bytes) + Buffer.byteLength(text.slice(0, start), "utf8");
  return {
    type: "TextQuoteSelector",
    exact,
    prefix: contextBefore(text, start),
    suffix: contextAfter(text, start + exact.length),
    startByte,
    endByte: startByte + Buffer.byteLength(exact, "utf8"),
  };
}

export function validateTextSelector(value, path = "selector") {
  const selector = plainObject(value, path);
  exactKeys(selector, ["type", "exact", "prefix", "suffix", "startByte", "endByte"], path);
  if (selector.type !== "TextQuoteSelector") fail("INVALID_DATA", `${path}.type must equal TextQuoteSelector.`);
  nonEmptyString(selector.exact, `${path}.exact`, MAX_QUOTE_CHARACTERS);
  if (typeof selector.prefix !== "string" || [...selector.prefix].length > 32) fail("INVALID_DATA", `${path}.prefix is invalid.`);
  if (typeof selector.suffix !== "string" || [...selector.suffix].length > 32) fail("INVALID_DATA", `${path}.suffix is invalid.`);
  integer(selector.startByte, `${path}.startByte`);
  integer(selector.endByte, `${path}.endByte`, selector.startByte + 1);
  return selector;
}

export function verifyTextSelector(bytes, selector) {
  validateTextSelector(selector);
  if (selector.endByte > bytes.length) fail("SELECTOR_MISMATCH", "Evidence byte offsets exceed the snapshot size.");
  const selected = decodeUtf8(bytes.subarray(selector.startByte, selector.endByte), "selected evidence");
  if (selected !== selector.exact) fail("SELECTOR_MISMATCH", "Evidence bytes no longer match the exact quote.");
  const rebuilt = createTextSelector(bytes, selector.exact);
  for (const key of ["prefix", "suffix", "startByte", "endByte"]) {
    if (rebuilt[key] !== selector[key]) fail("SELECTOR_MISMATCH", `Evidence ${key} no longer matches the snapshot.`);
  }
  return true;
}

export function validateWorkspace(value) {
  const workspace = plainObject(value, "workspace");
  exactKeys(workspace, ["schemaVersion", "id", "name", "createdAt"], "workspace");
  if (workspace.schemaVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `workspace.schemaVersion must equal ${SCHEMA_VERSION}.`);
  uuid(workspace.id, "workspace.id");
  nonEmptyString(workspace.name, "workspace.name", 120);
  timestamp(workspace.createdAt, "workspace.createdAt");
  return workspace;
}

function validateSource(value, path) {
  const source = plainObject(value, path);
  if (!["file", "upload", "http"].includes(source.type)) fail("INVALID_DATA", `${path}.type is unsupported.`);
  const allowed = source.type === "file"
    ? ["type", "label", "relativePath"]
    : source.type === "http"
      ? ["type", "label", "requestedUrl", "finalUrl", "status"]
      : ["type", "label"];
  exactKeys(source, allowed, path);
  nonEmptyString(source.label, `${path}.label`, 500);
  if (source.type === "http") {
    nonEmptyString(source.requestedUrl, `${path}.requestedUrl`, 2048);
    nonEmptyString(source.finalUrl, `${path}.finalUrl`, 2048);
    integer(source.status, `${path}.status`, 200, 299);
  }
  if (source.type === "file" && source.relativePath !== undefined) {
    nonEmptyString(source.relativePath, `${path}.relativePath`, 1024);
  }
  return source;
}

export function validateSnapshot(value, path = "snapshot") {
  const snapshot = plainObject(value, path);
  exactKeys(snapshot, ["schemaVersion", "id", "capturedAt", "mediaType", "byteLength", "sha256", "source"], path);
  if (snapshot.schemaVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `${path}.schemaVersion must equal ${SCHEMA_VERSION}.`);
  uuid(snapshot.id, `${path}.id`);
  timestamp(snapshot.capturedAt, `${path}.capturedAt`);
  if (typeof snapshot.mediaType !== "string" || !MEDIA_TYPE_PATTERN.test(snapshot.mediaType)) fail("INVALID_DATA", `${path}.mediaType is invalid.`);
  integer(snapshot.byteLength, `${path}.byteLength`, 0, MAX_SNAPSHOT_BYTES);
  if (!isSha256(snapshot.sha256)) fail("INVALID_DATA", `${path}.sha256 is invalid.`);
  validateSource(snapshot.source, `${path}.source`);
  return snapshot;
}

export function validateClaim(value, path = "claim") {
  const claim = plainObject(value, path);
  exactKeys(claim, ["schemaVersion", "id", "statement", "createdAt", "evidence"], path);
  if (claim.schemaVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `${path}.schemaVersion must equal ${SCHEMA_VERSION}.`);
  uuid(claim.id, `${path}.id`);
  nonEmptyString(claim.statement, `${path}.statement`, MAX_STATEMENT_CHARACTERS);
  timestamp(claim.createdAt, `${path}.createdAt`);
  if (!Array.isArray(claim.evidence) || claim.evidence.length === 0 || claim.evidence.length > 100) {
    fail("INVALID_DATA", `${path}.evidence must contain from 1 through 100 links.`);
  }
  claim.evidence.forEach((link, index) => {
    plainObject(link, `${path}.evidence[${index}]`);
    exactKeys(link, ["snapshotId", "selector"], `${path}.evidence[${index}]`);
    uuid(link.snapshotId, `${path}.evidence[${index}].snapshotId`);
    validateTextSelector(link.selector, `${path}.evidence[${index}].selector`);
  });
  return claim;
}

export function validateSnapshotBytes(snapshot, bytes) {
  validateSnapshot(snapshot);
  if (bytes.length !== snapshot.byteLength) fail("OBJECT_SIZE_MISMATCH", `Snapshot ${snapshot.id} has an unexpected byte length.`);
  if (sha256(bytes) !== snapshot.sha256) fail("OBJECT_HASH_MISMATCH", `Snapshot ${snapshot.id} failed SHA-256 verification.`);
  return true;
}

export function validateCollections(snapshots, claims) {
  if (!Array.isArray(snapshots)) fail("INVALID_DATA", "snapshots must be an array.");
  if (!Array.isArray(claims)) fail("INVALID_DATA", "claims must be an array.");
  const snapshotIds = new Set();
  snapshots.forEach((item, index) => {
    validateSnapshot(item, `snapshots[${index}]`);
    if (snapshotIds.has(item.id)) fail("DUPLICATE_ID", `Duplicate snapshot id ${item.id}.`);
    snapshotIds.add(item.id);
  });
  const claimIds = new Set();
  claims.forEach((item, index) => {
    validateClaim(item, `claims[${index}]`);
    if (claimIds.has(item.id)) fail("DUPLICATE_ID", `Duplicate claim id ${item.id}.`);
    claimIds.add(item.id);
    for (const evidence of item.evidence) {
      if (!snapshotIds.has(evidence.snapshotId)) {
        fail("MISSING_SNAPSHOT", `Claim ${item.id} refers to missing snapshot ${evidence.snapshotId}.`);
      }
    }
  });
  return true;
}
