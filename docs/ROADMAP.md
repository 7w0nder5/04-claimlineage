# Roadmap

ClaimLineage grows by preserving the integrity boundary, not by accumulating unrelated features. Each phase has an exit gate.

## 0.1 — Integrity foundation

Status: complete.

- Local workspace and immutable object storage
- File import and guarded single-resource HTTP capture
- Exact UTF-8 quote selectors with byte offsets and context
- Workspace verification and local-file drift checks
- Deterministic bundle export, verify, and import
- Loopback-only web interface and documented command line
- Cross-platform automated suite and release checks

Exit gate: deterministic round trip, tested corruption rejection, explicit security model, zero runtime dependencies.

Release maintenance includes comparing the HTTP address policy with the current IANA IPv4 and IPv6 special-purpose registries.

## 0.2 — Review ergonomics

- Multiple evidence links per claim through an explicit add/remove workflow
- Source and claim detail views with copyable stable IDs
- Human-readable verification report export
- Workspace backup guidance and recoverable metadata history
- Keyboard and screen-reader review on the supported browser matrix

Exit gate: usability study tasks can be completed without command-line assistance; every mutation remains testable and reversible.

## 0.3 — Document sources

- PDF text-layer extraction with page anchors
- Saved HTML reading view while retaining original response bytes
- Explicit character encoding records for non-UTF-8 web content

Exit gate: fixtures cover layout, encoding, malformed input, and cross-platform reproducibility. OCR remains separate until accuracy and provenance can be represented honestly.

## 0.4 — Team exchange

- Signed bundle manifest as an optional layer
- Bundle comparison and merge preview
- Review comments stored separately from immutable evidence

Exit gate: signature identity and trust policy are documented separately from byte integrity; merges never discard data silently.

## Deferred deliberately

Cloud accounts, background crawling, automated truth scoring, opaque AI summaries, browser extensions, blockchain storage, and mobile applications are outside the current plan. They require distinct privacy, reliability, or product validation work before implementation.
