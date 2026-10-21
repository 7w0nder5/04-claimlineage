# Contributing

ClaimLineage treats stored evidence as user data. Changes must preserve existing workspaces, reject ambiguous input, and include a regression test for every non-trivial branch.

## Development

Node.js 20 or newer is required. The project has no runtime or development dependencies.

```sh
npm test
npm run test:coverage
npm run check
```

Pull requests must keep the CLI contract, bundle schema, and security boundaries documented under `docs/` synchronized with the implementation. A schema change requires a migration fixture before it can merge.

## Compatibility

- Do not rename persisted keys or CLI options without a documented migration.
- Do not infer unknown fields, paths, encodings, or source formats.
- Do not weaken loopback, SSRF, size, redirect, or content-encoding controls for convenience.
- Do not render captured HTML as active markup.
