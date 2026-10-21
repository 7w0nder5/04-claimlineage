# CLI reference

The executable requires Node.js 20 or newer. Every option takes a value. Both `--name value` and `--name=value` are accepted. Repeated or unknown options fail closed.

## Workspace commands

```text
claimlineage init <directory> [--name <name>]
claimlineage import <file> [--workspace <directory>]
claimlineage capture <http-or-https-url> [--workspace <directory>]
claimlineage claim add --statement <text> --snapshot <id> --quote <text> [--workspace <directory>]
claimlineage list [--workspace <directory>] [--format text|json]
claimlineage verify [--workspace <directory>] [--format text|json]
claimlineage check <snapshot-id> [--workspace <directory>] [--format text|json]
```

`--workspace` defaults to the current directory. `check` returns `unchanged`, `changed`, `unavailable`, or `unsupported`.

| Exit code | Meaning |
| --- | --- |
| `0` | Operation succeeded, or a source was confirmed unchanged |
| `1` | A checked source changed |
| `2` | Input, data, or the requested operation was invalid |
| `3` | A source was unavailable or its source type cannot be checked |

## Bundle commands

```text
claimlineage bundle export <output.clb> [--workspace <directory>]
claimlineage bundle verify <input.clb> [--format text|json]
claimlineage bundle import <input.clb> <directory>
```

Export and import never overwrite an existing output file or workspace data directory. Verification reads and checks the bundle without writing a workspace.

## Local interface

```text
claimlineage serve [--workspace <directory>] [--port <number>]
```

The default port is `4177`. Port `0` asks the operating system to select an unused port. The process listens on `127.0.0.1` only and prints the full origin.
