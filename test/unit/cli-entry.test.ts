import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
it("runs the CLI main through an installed-package symlink path", async () => {
  const temp = await mkdtemp(join(tmpdir(), "observer-cli-entry-"));
  try {
    const realPackage = await realpath(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    const linkedPackage = join(temp, "pi-loop-observer");
    await symlink(realPackage, linkedPackage, "dir");
    const { stdout, stderr } = await execute(process.execPath, [
      join(linkedPackage, "dist/cli/main.js"),
      "--help",
    ]);
    expect(stdout).toContain("Pi Loop Observer");
    expect(stdout).toContain("open [--data-dir path]");
    expect(stderr).toBe("");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
