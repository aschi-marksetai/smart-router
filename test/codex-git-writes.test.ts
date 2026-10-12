import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResume,
  buildSpawn,
  codexToolchainNote,
} from "../src/harness/codex.ts";
import type { HarnessOptions } from "../src/harness/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { chooseCodexSandbox, routeQuestions } from "../src/route.ts";

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

test("merges extra writable roots and expands home only for workspace-write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-extra-roots-"));
  try {
    for (const codexSandbox of [
      "workspace-write",
      "read-only",
      "danger-full-access",
    ]) {
      const options: HarnessOptions = {
        cwd: directory,
        model: "gpt-6-luna",
        codexSandbox,
        strictMcpConfig: true,
        codexExtraWritableRoots: ["~/cache", "~", "/custom", "~/cache"],
        codexConfigOverrides: [`${WRITABLE_ROOTS_KEY}=['/configured']`],
      };
      for (const { argv } of [
        buildSpawn("task", options),
        buildResume("session", "again", options),
      ]) {
        const roots = argv.filter((argument) =>
          argument.startsWith(`${WRITABLE_ROOTS_KEY}=`),
        );
        expect(roots).toHaveLength(codexSandbox === "workspace-write" ? 2 : 1);
        if (codexSandbox === "workspace-write")
          expect(roots.at(-1)).toBe(
            `${WRITABLE_ROOTS_KEY}=${JSON.stringify(["/configured", join(homedir(), "cache"), homedir(), "/custom"])}`,
          );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects Swift and Xcode markers in ancestors but stops at the Git root", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "smart-router-swift-roots-")),
  );
  const cacheRoots = [
    join(homedir(), "Library/Caches/org.swift.swiftpm"),
    join(homedir(), ".cache/clang"),
  ];
  try {
    for (const marker of [
      "Package.swift",
      "Probe.xcodeproj",
      "Probe.xcworkspace",
      "none",
    ]) {
      const project = join(directory, `${marker}-fixture`);
      const cwd = join(project, "Sources");
      await mkdir(cwd, { recursive: true });
      if (marker === "Package.swift")
        await writeFile(join(project, marker), "");
      if (marker.endsWith(".xcodeproj") || marker.endsWith(".xcworkspace"))
        await mkdir(join(project, marker));
      for (const codexSandbox of [
        "workspace-write",
        "read-only",
        "danger-full-access",
      ]) {
        const options: HarnessOptions = {
          cwd,
          model: "gpt-6-luna",
          codexSandbox,
          strictMcpConfig: true,
        };
        const expectedRoots =
          marker === "Package.swift"
            ? cacheRoots
            : [
                ...cacheRoots,
                join(homedir(), "Library/Developer/Xcode/DerivedData"),
              ];
        const needsRoots =
          marker !== "none" && codexSandbox === "workspace-write";
        for (const { argv } of [
          buildSpawn("task", options),
          buildResume("session", "again", options),
        ]) {
          const rootOverrides = argv.filter((argument) =>
            argument.startsWith(`${WRITABLE_ROOTS_KEY}=`),
          );
          expect(rootOverrides).toEqual(
            needsRoots
              ? [`${WRITABLE_ROOTS_KEY}=${JSON.stringify(expectedRoots)}`]
              : [],
          );
        }
      }
    }
    await writeFile(join(directory, "Package.swift"), "");
    const repository = join(directory, "none-fixture");
    execFileSync("git", ["init", repository], { stdio: "pipe" });
    const { argv } = buildSpawn("task", {
      cwd: join(repository, "Sources"),
      model: "gpt-6-luna",
      strictMcpConfig: true,
    });
    expect(
      argv.findLast((argument) =>
        argument.startsWith(`${WRITABLE_ROOTS_KEY}=`),
      ),
    ).toBe(
      `${WRITABLE_ROOTS_KEY}=${JSON.stringify([join(repository, ".git")])}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("localhost networking is opt-in and only applies to workspace-write", async () => {
  expect(DEFAULT_CONFIG.spawn.codexLocalhostNeedsNetwork).toBe(false);
  expect(DEFAULT_CONFIG.spawn.codexExtraWritableRoots).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "smart-router-loopback-"));
  try {
    for (const codexSandbox of [
      "workspace-write",
      "read-only",
      "danger-full-access",
    ]) {
      for (const codexLocalhostNeedsNetwork of [undefined, false, true]) {
        for (const callerSandbox of [undefined, codexSandbox]) {
          const choice = chooseCodexSandbox({
            configuredSandbox: codexSandbox,
            callerSandbox,
            codexLocalhostNeedsNetwork,
            autoSandbox: false,
            allowFullAccess: true,
            routingRan: false,
            needsNetwork: null,
            needsFullAccess: null,
            needsBrowser: null,
          });
          const needsNetwork =
            codexSandbox === "workspace-write" &&
            codexLocalhostNeedsNetwork === true;
          expect(choice).toEqual({
            sandbox: codexSandbox,
            usesNetworkAccess: needsNetwork,
          });
          const options: HarnessOptions = {
            cwd: directory,
            model: "gpt-6-luna",
            codexSandbox,
            codexConfigOverrides: choice.usesNetworkAccess
              ? [NETWORK_OVERRIDE]
              : [],
            strictMcpConfig: true,
          };
          for (const { argv } of [
            buildSpawn("task", options),
            buildResume("session", "again", options),
          ]) {
            expect(argv.includes(NETWORK_OVERRIDE)).toBe(needsNetwork);
          }
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tells workspace-write Swift and Xcode delegates to disable nested manifest and macro sandboxes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-swift-note-"));
  try {
    expect(codexToolchainNote(directory, "workspace-write")).toBe("");
    for (const marker of [
      "Package.swift",
      "Probe.xcodeproj",
      "Probe.xcworkspace",
    ]) {
      const project = join(directory, `${marker}-fixture`);
      const cwd = join(project, "Sources");
      await mkdir(cwd, { recursive: true });
      if (marker === "Package.swift")
        await writeFile(join(project, marker), "");
      else await mkdir(join(project, marker));
      const note = codexToolchainNote(cwd, "workspace-write");
      expect(note).toContain("--disable-sandbox");
      expect(note).toContain(
        "xcodebuild with -IDEPackageSupportDisableManifestSandbox=YES",
      );
      expect(note).toContain(
        "OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox' for macro plugins",
      );
      expect(note).not.toContain("xcodebuild is unaffected");
      expect(note).not.toContain("-skipPackagePluginValidation");
      expect(codexToolchainNote(cwd, "danger-full-access")).toBe("");
      expect(codexToolchainNote(cwd, "read-only")).toBe("");
    }
    await writeFile(join(directory, "Package.swift"), "");
    const repository = join(directory, "repository");
    execFileSync("git", ["init", repository], { stdio: "pipe" });
    expect(codexToolchainNote(repository, "workspace-write")).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Jev full-access instructions identify CoreSimulator and WebKit tasks", () => {
  const { instructions } = routeQuestions([]).needsFullAccess;
  for (const task of [
    "iOS Simulator",
    "simctl",
    "XCUITest",
    "UI-test",
    "WebKit",
    "WKWebView",
  ])
    expect(instructions).toContain(task);
  expect(instructions).toContain("requiring full access");
  expect(instructions).toContain("even with extra writable roots");
  expect(instructions).toContain("content rule-list compilation");
  expect(instructions).toContain("even with SwiftPM --disable-sandbox");
});
