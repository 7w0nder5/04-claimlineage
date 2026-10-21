import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, VERSION } from "../packages/cli/src/cli.js";
import { loadWorkspace } from "../packages/storage/src/workspace.js";
import { memoryIo, temporaryDirectory } from "./helpers.js";

async function run(args) {
  const io = memoryIo();
  const code = await main(args, io);
  return { code, ...io.read() };
}

test("CLI help, version, unknown command, and invalid options are stable", async () => {
  assert.match((await run([])).stdout, /Usage:/);
  assert.equal((await run(["--version"])).stdout, `${VERSION}\n`);
  const unknown = await run(["unknown"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /UNKNOWN_COMMAND/);
  const duplicate = await run(["list", "--format", "json", "--format", "text"]);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /DUPLICATE_OPTION/);
});

test("CLI executable starts correctly from Unicode and fragment-like paths", async (t) => {
  const root = path.join(await temporaryDirectory(t), "资料 #1");
  const cli = fileURLToPath(new URL("../packages/cli/src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "init", root, "--name", "Unicode workspace"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Initialized ClaimLineage workspace/);
  assert.equal((await loadWorkspace(root)).workspace.name, "Unicode workspace");
});

test("CLI completes init, import, claim, verify, drift, export, verify, and import", async (t) => {
  const parent = await temporaryDirectory(t);
  const root = path.join(parent, "work #1");
  const source = path.join(parent, "source file.txt");
  await writeFile(source, "Exact evidence appears here.\n");
  assert.equal((await run(["init", root, "--name", "CLI workspace"])).code, 0);
  assert.equal((await run(["import", source, "--workspace", root])).code, 0);
  const state = await loadWorkspace(root);
  const snapshotId = state.snapshots[0].id;
  assert.equal((await run([
    "claim", "add",
    "--workspace", root,
    "--statement", "Evidence exists.",
    "--snapshot", snapshotId,
    "--quote", "Exact evidence",
  ])).code, 0);
  const listed = await run(["list", "--workspace", root, "--format", "json"]);
  assert.equal(JSON.parse(listed.stdout).claims.length, 1);
  assert.equal((await run(["verify", "--workspace", root])).code, 0);
  assert.match((await run(["check", snapshotId, "--workspace", root])).stdout, /unchanged/);
  await writeFile(source, "Changed source.\n");
  assert.equal((await run(["check", snapshotId, "--workspace", root])).code, 1);

  const bundle = path.join(parent, "evidence.clb");
  const restored = path.join(parent, "restored");
  assert.equal((await run(["bundle", "export", bundle, "--workspace", root])).code, 0);
  assert.equal((await run(["bundle", "verify", bundle, "--format", "json"])).code, 0);
  assert.equal((await run(["bundle", "import", bundle, restored])).code, 0);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".claimlineage", "claims.json"), "utf8")),
    JSON.parse(await readFile(path.join(restored, ".claimlineage", "claims.json"), "utf8")),
  );
});

test("CLI returns code 2 for malformed claim and absent workspace", async (t) => {
  const root = await temporaryDirectory(t);
  const absent = await run(["verify", "--workspace", path.join(root, "absent")]);
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /MISSING_WORKSPACE/);
  const malformed = await run(["claim", "remove"]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /INVALID_ARGUMENT/);
});
