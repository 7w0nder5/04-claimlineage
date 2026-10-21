# Project 04 · ClaimLineage

> Independent GitHub Project 04

ClaimLineage is a local-first workspace that connects claims to exact quotes inside immutable source snapshots, detects source drift, and exports evidence bundles that another machine can verify offline.

It answers a narrow but important question: **does this claim still point to the same saved evidence bytes?** It does not decide whether a claim or source is true.

```text
claim
  └─ exact quote + UTF-8 byte offsets
       └─ immutable snapshot
            └─ SHA-256 digest
                 └─ deterministic offline bundle
```

[简体中文](README.zh-CN.md)

## Why it exists

Web links change, disappear, and silently replace their contents. A large study of scholarly documents found almost 10% of links were dead, while more recent research describes the continuing problem as reference rot ([Zittrain, Albert, and Lessig](https://arxiv.org/abs/1901.07440), [Klein et al.](https://arxiv.org/abs/2401.04887)). A bookmark or citation manager can preserve a reference, but a reviewer still needs to know which saved bytes support which statement.

The W3C PROV family describes provenance as information used to assess quality, reliability, and trustworthiness, and defines a model for exchanging it ([PROV Overview](https://www.w3.org/TR/prov-overview/), [PROV Primer](https://www.w3.org/TR/prov-primer/)). ClaimLineage applies that principle to a practical local workflow: snapshot, quote, verify, share.

Existing tools cover adjacent needs. Zotero manages references and attachments ([Zotero quick start guide](https://www.zotero.org/support/quick_start_guide)); Hypothesis exports annotations ([Hypothesis export documentation](https://web.hypothes.is/help/exporting-and-importing-annotations/)); GitHub artifact attestations connect build artifacts to their origin, while explicitly not guaranteeing that an artifact is safe ([GitHub documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations)). ClaimLineage focuses on the missing connection between a human-readable claim, an exact passage, immutable bytes, and a portable verifier.

## Try it in two minutes

Node.js 20 or newer is the only requirement. There are no runtime dependencies and no install step.

```sh
node packages/cli/src/cli.js init demo --name "Demo investigation"
node packages/cli/src/cli.js import examples/source.txt --workspace demo
node packages/cli/src/cli.js list --workspace demo
```

Copy the snapshot ID printed by `list`, then create a claim using an exact, unique quote:

```sh
node packages/cli/src/cli.js claim add --workspace demo --snapshot <snapshot-id> --statement "Archived pages can still be checked offline." --quote "A saved source snapshot can be verified later"
node packages/cli/src/cli.js verify --workspace demo
node packages/cli/src/cli.js bundle export demo.clb --workspace demo
node packages/cli/src/cli.js bundle verify demo.clb
```

For the local web interface:

```sh
node packages/cli/src/cli.js serve --workspace demo
```

Open the printed loopback URL. The server binds only to `127.0.0.1`, creates a fresh session token, and sends no analytics, cookies, or remote assets.

## Core workflow

1. **Initialize a workspace.** ClaimLineage creates a `.claimlineage` directory with versioned JSON metadata and a content-addressed object store.
2. **Save a source.** Import a local UTF-8 file, upload one through the local interface, or explicitly capture one public HTTP or HTTPS resource.
3. **Connect a claim.** The selected quote must occur exactly once. ClaimLineage stores the quote, context, and exact UTF-8 byte offsets.
4. **Verify.** The verifier recalculates every SHA-256 digest and replays every quote selector against the stored bytes.
5. **Check drift.** Local sources can be compared with the saved snapshot without changing it.
6. **Export.** A canonical `.clb` file includes public metadata and the referenced objects. Absolute local paths are excluded.

## Commands

| Command | Result |
| --- | --- |
| `init <directory> [--name <name>]` | Create a new workspace without overwriting one |
| `import <file> [--workspace <directory>]` | Copy one local file into immutable storage |
| `capture <url> [--workspace <directory>]` | Capture one public HTTP or HTTPS resource |
| `claim add ...` | Bind one statement to one exact quote |
| `list [--format text\|json]` | Show workspace contents |
| `verify [--format text\|json]` | Verify every object and evidence selector |
| `check <snapshot-id>` | Compare a source with its saved snapshot |
| `bundle export <file>` | Write a deterministic evidence bundle |
| `bundle verify <file>` | Verify a bundle without importing it |
| `bundle import <file> <directory>` | Restore a verified bundle into a new workspace |
| `serve [--port <number>]` | Start the loopback-only web interface |

Exit code `0` means success or no detected drift, `1` means a checked source changed, and `2` means the request or data was invalid. See [CLI reference](docs/CLI.md) for the exact forms.

## Integrity and network boundaries

- Snapshots are immutable and addressed by lowercase SHA-256.
- Metadata writes use a workspace lock, temporary file, file sync, and atomic rename.
- Existing workspaces and bundle output files are never overwritten.
- Every redirect target is validated and resolved again. If any returned IP address is private, loopback, link-local, reserved, documentation-only, or multicast, capture stops.
- HTTPS-to-HTTP redirects, URL credentials, compressed responses, responses over 10 MiB, and more than five redirects are rejected.
- Bundles are limited to 64 MiB and reject absent, corrupt, malformed, or unreferenced objects.
- Workspace metadata and object paths reject symbolic links.
- The web API requires both a per-process token and the exact loopback host; write requests also require the exact origin.

These controls prove content integrity within the stated model. They do not prove authorship, authenticity, factual accuracy, or safety. Read the [security model](docs/spec/security.md) before using ClaimLineage in a sensitive workflow.

## Data format

The workspace format and `.clb` bundle format are documented, versioned, deterministic, and designed for independent verification:

- [Data model](docs/spec/data-model.md)
- [Bundle format](docs/BUNDLE_FORMAT.md)
- [Local-first storage decision](docs/adr/0001-local-first-files.md)

## Development

```sh
npm test
npm run check
npm run test:coverage
```

The suite covers canonical JSON, UTF-8 and byte-order marks, exact quote selection, duplicate and missing references, object tampering, locks, source drift, deterministic round trips, network address policy, redirect safety, size and encoding limits, CLI exit codes, web security boundaries, and Unicode or space-containing paths. CI runs on Linux, Windows, and macOS with Node.js 20 and 24.

## Project status

Version `0.1.0` is a complete, intentionally narrow foundation. The stable storage and bundle contracts come before collaboration, browser extensions, PDF extraction, OCR, or automated claim evaluation. Planned work and its acceptance gates live in [the roadmap](docs/ROADMAP.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Any format change needs a compatibility decision, documentation, and tests. Dependencies require a written reason.

## License

[MIT](LICENSE)
