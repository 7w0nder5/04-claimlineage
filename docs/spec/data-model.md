# Data model contract

The workspace data directory is exactly `.claimlineage/`.

```text
.claimlineage/
├─ workspace.json
├─ snapshots.json
├─ claims.json
├─ local-sources.json
└─ objects/
   └─ <64 lowercase hexadecimal SHA-256 characters>
```

All JSON documents use UTF-8, schema version `1`, sorted object keys, two-space indentation, and one trailing line feed. Snapshot metadata updates are journaled before write-to-temporary-file and atomic rename; an interrupted operation is completed or rolled back on the next load. Snapshot objects are immutable and addressed by their SHA-256 digest.

`local-sources.json` contains machine-local absolute file paths used only for drift checks. It is never included in an evidence bundle or returned by the web API.

Claims link to evidence with both:

- a `TextQuoteSelector` containing the exact quote plus bounded prefix and suffix context; and
- UTF-8 byte offsets into the stored object.

The quote must occur exactly once when it is created. Verification checks the digest, reference, offsets, exact quote, prefix, and suffix.

Evidence bundles use `format: "claimlineage-bundle"` and `schemaVersion: 1`. Bundle JSON is canonical and contains base64 object bytes keyed by the lowercase digest. Export contains no export timestamp, so identical workspace state produces identical bundle bytes.
