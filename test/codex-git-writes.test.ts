import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResume, buildSpawn } from "../src/harness/codex.ts";
import type { HarnessOptions } from "../src/harness/types.ts";

const WRITABLE_ROOTS_KEY = "sandbox_workspace_write.writable_roots";
const NETWORK_OVERRIDE = "sandbox_workspace_write.network_access=true";

test("merges Git metadata roots on spawn and resume only for workspace-write Git cwds", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "smart-router-git-writes-")),
  );
  const originalCodexHome = process.env.CODEX_HOME;
  const normalRepository = join(directory, "normal");
  const worktree = join(directory, "worktree");
  const nonGitDirectory = join(directory, "non-git");
  const codexHome = join(directory, "codex-home");
  const configuredRoot = join(directory, "configured");
  const overrideRoot = join(directory, "override");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    for (const path of [normalRepository, nonGitDirectory, codexHome])
      await mkdir(path);
    await writeFile(
      join(codexHome, "config.toml"),
      `${WRITABLE_ROOTS_KEY}=${JSON.stringify([configuredRoot])}`,
    );
    process.env.CODEX_HOME = codexHome;
    git(normalRepository, "init");
    git(normalRepository, "config", "user.name", "Test");
    git(normalRepository, "config", "user.email", "test@example.test");
    git(normalRepository, "config", "commit.gpgsign", "false");
    git(normalRepository, "commit", "--allow-empty", "-m", "initial");
    git(normalRepository, "worktree", "add", "-b", "test", worktree);
    for (const cwd of [normalRepository, worktree, nonGitDirectory]) {
      for (const codexSandbox of [
        undefined,
        "workspace-write",
        "read-only",
        "danger-full-access",
      ]) {
        const options: HarnessOptions = {
          cwd,
          model: "gpt-6-luna",
          codexSandbox,
          codexConfigOverrides: [
            NETWORK_OVERRIDE,
            `${WRITABLE_ROOTS_KEY}=['${overrideRoot}']`,
          ],
        };
        const needsGitRoots =
          cwd !== nonGitDirectory &&
          (codexSandbox === undefined || codexSandbox === "workspace-write");
        const commonDirectory = join(normalRepository, ".git");
        const expectedRoots = [configuredRoot, overrideRoot];
        if (cwd === worktree)
          expectedRoots.push(join(commonDirectory, "worktrees", "worktree"));
        expectedRoots.push(commonDirectory);
        for (const { argv } of [
          buildSpawn("task", options),
          buildResume("session", "again", options),
        ]) {
          const rootOverrides = argv.filter((argument) =>
            argument.startsWith(`${WRITABLE_ROOTS_KEY}=`),
          );
          expect(argv).toContain(NETWORK_OVERRIDE);
          expect(rootOverrides).toHaveLength(needsGitRoots ? 2 : 1);
          if (needsGitRoots)
            expect(rootOverrides.at(-1)).toBe(
              `${WRITABLE_ROOTS_KEY}=${JSON.stringify([...new Set(expectedRoots)])}`,
            );
        }
      }
    }
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(directory, { recursive: true, force: true });
  }
});
