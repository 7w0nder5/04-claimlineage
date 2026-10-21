import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaimLineageError,
  canonicalJson,
  createTextSelector,
  decodeUtf8,
  sha256,
  validateCollections,
  verifyTextSelector,
} from "../packages/core/src/index.js";

test("canonical JSON sorts every object and ends with one newline", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: null } }), '{\n  "a": {\n    "b": null,\n    "y": true\n  },\n  "z": 1\n}\n');
});

test("canonical JSON rejects unsupported and unstable values", () => {
  for (const value of [NaN, Infinity, undefined, new Date()]) {
    assert.throws(() => canonicalJson(value), ClaimLineageError);
  }
  assert.throws(() => canonicalJson({ missing: undefined }), /must not be undefined/);
});

test("canonical JSON preserves a literal prototype-named key as data", () => {
  const value = JSON.parse('{"__proto__":"kept","a":1}');
  assert.equal(canonicalJson(value), '{\n  "__proto__": "kept",\n  "a": 1\n}\n');
});

test("SHA-256 is stable for bytes", () => {
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("UTF-8 decoder rejects malformed bytes", () => {
  assert.throws(() => decodeUtf8(Buffer.from([0xc3, 0x28])), /not valid UTF-8/);
});

test("text selector records UTF-8 byte offsets, context, and BOM", () => {
  const bytes = Buffer.from("\ufeffalpha 猫 beta", "utf8");
  const selector = createTextSelector(bytes, "猫");
  assert.deepEqual(selector, {
    type: "TextQuoteSelector",
    exact: "猫",
    prefix: "alpha ",
    suffix: " beta",
    startByte: 9,
    endByte: 12,
  });
  assert.equal(verifyTextSelector(bytes, selector), true);
});

test("text selector rejects absent and repeated quotes", () => {
  assert.throws(() => createTextSelector(Buffer.from("one two"), "three"), /does not occur/);
  assert.throws(() => createTextSelector(Buffer.from("same same"), "same"), /more than once/);
});

test("text selector verification detects offset and context changes", () => {
  const bytes = Buffer.from("before exact after");
  const selector = createTextSelector(bytes, "exact");
  assert.throws(() => verifyTextSelector(bytes, { ...selector, startByte: 0 }), /no longer match|no longer matches/);
  assert.throws(() => verifyTextSelector(bytes, { ...selector, prefix: "wrong" }), /prefix no longer matches/);
});

test("collection validation rejects missing references and duplicate ids", () => {
  const snapshot = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    capturedAt: "2026-01-02T03:04:05.000Z",
    mediaType: "text/plain",
    byteLength: 1,
    sha256: sha256(Buffer.from("x")),
    source: { type: "upload", label: "x.txt" },
  };
  assert.throws(() => validateCollections([snapshot, snapshot], []), /Duplicate snapshot id/);
  const claim = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    statement: "A statement",
    createdAt: "2026-01-02T03:04:05.000Z",
    evidence: [{
      snapshotId: "00000000-0000-4000-8000-000000000099",
      selector: createTextSelector(Buffer.from("x"), "x"),
    }],
  };
  assert.throws(() => validateCollections([snapshot], [claim]), /refers to missing snapshot/);
});

test("record validation rejects undocumented fields", () => {
  const snapshot = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    capturedAt: "2026-01-02T03:04:05.000Z",
    mediaType: "text/plain",
    byteLength: 1,
    sha256: sha256(Buffer.from("x")),
    source: { type: "upload", label: "x.txt", localPath: "secret" },
  };
  assert.throws(() => validateCollections([snapshot], []), /localPath is not a supported field/);
});
