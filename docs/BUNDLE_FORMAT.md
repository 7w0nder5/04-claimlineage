# ClaimLineage bundle format

The `.clb` extension denotes one strictly decoded UTF-8 JSON document. It is not a ZIP archive. Writers use two-space indentation, lexicographically sorted object keys, and one final newline. Readers accept only that canonical serialization; this also rejects duplicate JSON keys and parser-dependent byte sequences.

## Top-level fields

```json
{
  "format": "claimlineage-bundle",
  "schemaVersion": 1,
  "workspace": {},
  "snapshots": [],
  "claims": [],
  "objects": {}
}
```

- `workspace`, `snapshots`, and `claims` use the records in [the data model](spec/data-model.md).
- `snapshots` and `claims` are sorted by their exact `id` strings.
- `objects` maps each lowercase SHA-256 digest to canonical base64 of its bytes.
- Each object must be referenced by at least one snapshot, and each snapshot digest must have one object.
- Local source paths and write locks are never included.

## Verification order

1. Enforce the 64 MiB file limit and parse JSON.
2. Check `format` and `schemaVersion` exactly.
3. Validate all records, IDs, timestamps, media types, limits, and references.
4. Decode canonical base64 and enforce the 10 MiB per-object limit.
5. Recalculate every object SHA-256 and byte length.
6. Replay every text selector against the referenced object.
7. Reject unreferenced objects.

Readers reject more than 10,000 snapshots, 10,000 claims, or 20,000 evidence links before deep validation. Repeated identical selectors are checked once, and unique selector verification is limited to 268,435,456 snapshot byte-checks per bundle.

The SHA-256 printed by `bundle verify` covers the entire `.clb` file. It identifies the deterministic serialized bundle; the per-object hashes protect each snapshot independently.

## Compatibility

Readers support only `schemaVersion: 1`. A future incompatible format will use a different version and must define an explicit migration path. Unknown structures are not silently rewritten.
