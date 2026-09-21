import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDetached, runForeground } from "../src/runner.ts";

test("runs a detached process with stdout and stderr redirected separately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-runner-"));
  const logPath = join(directory, "output.log");
  const { errPath, pid } = await runDetached(
    ["sh", "-c", "printf detached; printf warning >&2"],
    directory,
    logPath,
  );
  expect(pid).toBeGreaterThan(0);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (
        (await readFile(logPath, "utf8")) === "detached" &&
        (await readFile(errPath, "utf8")) === "warning"
      )
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await readFile(logPath, "utf8")).toBe("detached");
  expect(await readFile(errPath, "utf8")).toBe("warning");
});

test("includes stdout and stderr in foreground command failures", async () => {
  await expect(
    runForeground(
      ["sh", "-c", "printf output; printf failure >&2; exit 7"],
      process.cwd(),
    ),
  ).rejects.toThrow(/sh.*7[\s\S]*output[\s\S]*failure/);
});

test("rejects a detached process that cannot launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-runner-"));
  await expect(
    runDetached(
      ["missing-smart-router-command"],
      directory,
      join(directory, "output.log"),
    ),
  ).rejects.toThrow(/missing-smart-router-command/);
});
