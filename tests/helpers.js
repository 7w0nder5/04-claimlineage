import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function temporaryDirectory(t, prefix = "claimlineage-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function fixedIdentity() {
  let sequence = 0;
  return {
    idFactory() {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  };
}

export function memoryIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    read() { return { stdout, stderr }; },
  };
}
