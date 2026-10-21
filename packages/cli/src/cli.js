#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ClaimLineageError, sha256 } from "../../core/src/index.js";
import { captureHttp, fetchHttpSnapshot } from "../../capture/src/http.js";
import { importFile } from "../../capture/src/file.js";
import {
  addClaim,
  currentSourceBytes,
  initWorkspace,
  loadWorkspace,
  verifyWorkspace,
} from "../../storage/src/workspace.js";
import { exportBundle, importBundle, verifyBundleFile } from "../../export/src/bundle.js";
import { startWebServer } from "../../../apps/web/server.js";
import { expectPositionals, parseTokens, rejectFlags, takeFlag } from "./arguments.js";

export const VERSION = "0.1.0";

const HELP = `ClaimLineage ${VERSION}

Usage:
  claimlineage init <directory> [--name <name>]
  claimlineage import <file> [--workspace <directory>]
  claimlineage capture <http-or-https-url> [--workspace <directory>]
  claimlineage claim add --statement <text> --snapshot <id> --quote <text> [--workspace <directory>]
  claimlineage list [--workspace <directory>] [--format text|json]
  claimlineage verify [--workspace <directory>] [--format text|json]
  claimlineage check <snapshot-id> [--workspace <directory>] [--format text|json]
  claimlineage bundle export <output.clb> [--workspace <directory>]
  claimlineage bundle verify <input.clb> [--format text|json]
  claimlineage bundle import <input.clb> <directory>
  claimlineage serve [--workspace <directory>] [--port <number>]

Exit codes: 0 success or unchanged, 1 source changed, 2 invalid input or operation failure, 3 source unavailable or unsupported.`;

function terminalText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`;
  });
}

function formatValue(value, format) {
  return format === "json" ? JSON.stringify(value, null, 2) : value;
}

function parseFormat(flags) {
  const format = takeFlag(flags, "format", "text");
  if (format !== "text" && format !== "json") throw new ClaimLineageError("INVALID_FORMAT", "--format must be text or json.");
  return format;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ClaimLineageError("INVALID_PORT", "--port must be an integer from 0 through 65535.");
  return port;
}

async function checkSource(workspaceRoot, snapshotId) {
  const state = await loadWorkspace(workspaceRoot);
  const snapshot = state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) throw new ClaimLineageError("MISSING_SNAPSHOT", `Snapshot ${snapshotId} does not exist.`);
  if (snapshot.source.type === "file") {
    const result = await currentSourceBytes(workspaceRoot, snapshotId);
    return { snapshotId, sourceType: "file", status: result.status, recordedSha256: snapshot.sha256, currentSha256: result.bytes ? sha256(result.bytes) : null };
  }
  if (snapshot.source.type === "http") {
    const current = await fetchHttpSnapshot(snapshot.source.requestedUrl);
    const currentHash = sha256(current.bytes);
    return { snapshotId, sourceType: "http", status: currentHash === snapshot.sha256 ? "unchanged" : "changed", recordedSha256: snapshot.sha256, currentSha256: currentHash, finalUrl: current.source.finalUrl };
  }
  return { snapshotId, sourceType: snapshot.source.type, status: "unsupported", recordedSha256: snapshot.sha256, currentSha256: null };
}

export async function main(arguments_ = process.argv.slice(2), io = process) {
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (arguments_[0] === "--version" || arguments_[0] === "-v") {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    const command = arguments_[0];
    const parsed = parseTokens(arguments_.slice(1));
    const workspaceRoot = path.resolve(takeFlag(parsed.flags, "workspace", "."));

    if (command === "init") {
      expectPositionals(parsed.positionals, 1, "one destination directory");
      const name = takeFlag(parsed.flags, "name");
      rejectFlags(parsed.flags);
      const result = await initWorkspace(parsed.positionals[0], { name });
      io.stdout.write(`Initialized ClaimLineage workspace ${terminalText(result.workspace.id)} at ${terminalText(result.root)}\n`);
      return 0;
    }

    if (command === "import") {
      expectPositionals(parsed.positionals, 1, "one source file");
      rejectFlags(parsed.flags);
      const snapshot = await importFile(workspaceRoot, parsed.positionals[0]);
      io.stdout.write(`Imported ${terminalText(snapshot.source.label)} as snapshot ${terminalText(snapshot.id)} (${terminalText(snapshot.sha256)})\n`);
      return 0;
    }

    if (command === "capture") {
      expectPositionals(parsed.positionals, 1, "one HTTP or HTTPS URL");
      rejectFlags(parsed.flags);
      const snapshot = await captureHttp(workspaceRoot, parsed.positionals[0]);
      io.stdout.write(`Captured ${terminalText(snapshot.source.finalUrl)} as snapshot ${terminalText(snapshot.id)} (${terminalText(snapshot.sha256)})\n`);
      return 0;
    }

    if (command === "claim") {
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "add") throw new ClaimLineageError("INVALID_ARGUMENT", "Expected claim add.");
      const statement = takeFlag(parsed.flags, "statement");
      const snapshotId = takeFlag(parsed.flags, "snapshot");
      const quote = takeFlag(parsed.flags, "quote");
      rejectFlags(parsed.flags);
      const claim = await addClaim(workspaceRoot, { statement, snapshotId, quote });
      io.stdout.write(`Created claim ${terminalText(claim.id)} with evidence from snapshot ${terminalText(snapshotId)}\n`);
      return 0;
    }

    if (command === "list") {
      expectPositionals(parsed.positionals, 0, "no positional arguments");
      const format = parseFormat(parsed.flags);
      rejectFlags(parsed.flags);
      const state = await loadWorkspace(workspaceRoot);
      if (format === "json") {
        io.stdout.write(`${formatValue({ workspace: state.workspace, snapshots: state.snapshots, claims: state.claims }, format)}\n`);
      } else {
        io.stdout.write(`${terminalText(state.workspace.name)}: ${state.snapshots.length} snapshot(s), ${state.claims.length} claim(s)\n`);
        for (const snapshot of state.snapshots) io.stdout.write(`S ${terminalText(snapshot.id)} ${terminalText(snapshot.source.label)} ${terminalText(snapshot.sha256)}\n`);
        for (const claim of state.claims) io.stdout.write(`C ${terminalText(claim.id)} ${terminalText(claim.statement)}\n`);
      }
      return 0;
    }

    if (command === "verify") {
      expectPositionals(parsed.positionals, 0, "no positional arguments");
      const format = parseFormat(parsed.flags);
      rejectFlags(parsed.flags);
      const report = await verifyWorkspace(workspaceRoot);
      io.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `Workspace intact: ${report.snapshots} snapshot(s), ${report.claims} claim(s), ${report.objects} object(s).\n`);
      return 0;
    }

    if (command === "check") {
      expectPositionals(parsed.positionals, 1, "one snapshot id");
      const format = parseFormat(parsed.flags);
      rejectFlags(parsed.flags);
      const report = await checkSource(workspaceRoot, parsed.positionals[0]);
      io.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `Source ${terminalText(report.status)}: ${terminalText(report.snapshotId)}\n`);
      if (report.status === "changed") return 1;
      if (report.status === "unavailable" || report.status === "unsupported") return 3;
      return 0;
    }

    if (command === "bundle") {
      const action = parsed.positionals[0];
      if (action === "export") {
        expectPositionals(parsed.positionals, 2, "bundle export and one output file");
        rejectFlags(parsed.flags);
        const result = await exportBundle(workspaceRoot, parsed.positionals[1]);
        io.stdout.write(`Exported ${terminalText(result.output)} (${result.byteLength} bytes, ${terminalText(result.sha256)})\n`);
        return 0;
      }
      if (action === "verify") {
        expectPositionals(parsed.positionals, 2, "bundle verify and one input file");
        const format = parseFormat(parsed.flags);
        rejectFlags(parsed.flags);
        const report = await verifyBundleFile(parsed.positionals[1]);
        io.stdout.write(format === "json" ? `${JSON.stringify(report, (key, value) => key === "objects" ? undefined : value, 2)}\n` : `Bundle intact: ${report.snapshots} snapshot(s), ${report.claims} claim(s), SHA-256 ${report.sha256}.\n`);
        return 0;
      }
      if (action === "import") {
        expectPositionals(parsed.positionals, 3, "bundle import, one input file, and one destination directory");
        rejectFlags(parsed.flags);
        const result = await importBundle(parsed.positionals[1], parsed.positionals[2]);
        io.stdout.write(`Imported workspace ${terminalText(result.workspaceId)} at ${terminalText(result.root)}\n`);
        return 0;
      }
      throw new ClaimLineageError("INVALID_ARGUMENT", "Expected bundle export, bundle verify, or bundle import.");
    }

    if (command === "serve") {
      expectPositionals(parsed.positionals, 0, "no positional arguments");
      const port = parsePort(takeFlag(parsed.flags, "port", "4177"));
      rejectFlags(parsed.flags);
      const { origin } = await startWebServer(workspaceRoot, { port });
      io.stdout.write(`ClaimLineage is available at ${terminalText(origin)}\nPress Ctrl+C to stop.\n`);
      return await new Promise(() => {});
    }

    throw new ClaimLineageError("UNKNOWN_COMMAND", `Unknown command ${JSON.stringify(command)}.`);
  } catch (error) {
    if (error instanceof ClaimLineageError) {
      io.stderr.write(`claimlineage: ${terminalText(error.message)} [${terminalText(error.code)}]\n`);
      return 2;
    }
    io.stderr.write(`claimlineage: unexpected failure: ${terminalText(error.message)}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main();
}
