import { expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardrailsTemplate,
  preferencesInterviewTemplate,
  preferencesTemplate,
  skill,
} from "../src/assets.ts";
import {
  addCodexGuardHook,
  CODEX_GUARD_COMMAND,
  CODEX_GUARD_MATCHER,
  installSkill,
} from "../src/install.ts";

test("embedded assets are non-empty", () => {
  for (const asset of [
    preferencesTemplate,
    preferencesInterviewTemplate,
    guardrailsTemplate,
    skill,
  ])
    expect(asset.length).toBeGreaterThan(0);
});

test("install writes the skill for Claude Code and Codex and adds the Codex guard hook once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-"));
  const previous = {
    claude: process.env.CLAUDE_CONFIG_DIR,
    codex: process.env.CODEX_HOME,
  };
  const codexHome = join(directory, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  process.env.CODEX_HOME = codexHome;
  const messages: string[] = [];
  try {
    const installed = await installSkill((text) => messages.push(text));
    expect(installed).toMatchObject({
      skillPath: join(directory, "claude", "skills/smart-router/SKILL.md"),
      codexSkillPath: join(codexHome, "skills/smart-router/SKILL.md"),
      codexHooksPath: join(codexHome, "hooks.json"),
      codexHookAdded: true,
      codexHooksBackup: null,
    });
    expect(await readFile(installed.skillPath, "utf8")).toBe(skill);
    expect(await readFile(installed.codexSkillPath, "utf8")).toBe(skill);
    const guardEntry = {
      matcher: CODEX_GUARD_MATCHER,
      hooks: [{ type: "command", command: CODEX_GUARD_COMMAND, timeout: 6 }],
    };
    expect(
      JSON.parse(await readFile(installed.codexHooksPath, "utf8")),
    ).toEqual({ hooks: { PreToolUse: [guardEntry] } });
    expect(messages[0]).toContain("approve the hook with /hooks");
    const again = await installSkill((text) => messages.push(text));
    expect(again).toMatchObject({
      codexHookAdded: false,
      codexHooksBackup: null,
    });
    expect(messages[1]).toContain("already in");
    expect(readdirSync(codexHome).sort()).toEqual(["hooks.json", "skills"]);
  } finally {
    for (const [name, value] of [
      ["CLAUDE_CONFIG_DIR", previous.claude],
      ["CODEX_HOME", previous.codex],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Codex hook merge keeps existing hooks, backs the file up and follows a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-"));
  try {
    const codexHome = join(directory, "codex");
    const realFile = join(directory, "dotfiles-hooks.json");
    const existing = {
      note: "kept",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "other-guard" }] }],
      },
    };
    await mkdir(codexHome);
    await writeFile(realFile, JSON.stringify(existing));
    await symlink(realFile, join(codexHome, "hooks.json"));
    const added = await addCodexGuardHook(
      codexHome,
      new Date("2026-11-27T08:09:10.123Z"),
    );
    expect(added).toEqual({
      codexHooksPath: join(codexHome, "hooks.json"),
      codexHookAdded: true,
      codexHooksBackup: join(codexHome, "hooks.json.bak-20261127080910123"),
    });
    expect(JSON.parse(await readFile(added.codexHooksBackup!, "utf8"))).toEqual(
      existing,
    );
    expect(lstatSync(join(codexHome, "hooks.json")).isSymbolicLink()).toBe(
      true,
    );
    const merged = JSON.parse(await readFile(realFile, "utf8"));
    expect(merged.note).toBe("kept");
    expect(merged.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(merged.hooks.PreToolUse[1].hooks[0].command).toBe(
      CODEX_GUARD_COMMAND,
    );
    expect((await addCodexGuardHook(codexHome)).codexHookAdded).toBe(false);
    expect(JSON.parse(await readFile(realFile, "utf8"))).toEqual(merged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Codex hook merge refuses a hooks file it cannot read as an object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-"));
  try {
    const hooksPath = join(directory, "hooks.json");
    for (const content of ["[1]", "not json"]) {
      await writeFile(hooksPath, content);
      await expect(addCodexGuardHook(directory)).rejects.toThrow();
      expect(await readFile(hooksPath, "utf8")).toBe(content);
    }
    await rm(hooksPath);
    await mkdir(hooksPath);
    await expect(addCodexGuardHook(directory)).rejects.toThrow();
    await rm(hooksPath, { recursive: true });
    // A hooks file whose nested shape is not what Codex expects is refused before any backup or write.
    for (const malformed of [
      { hooks: { PreToolUse: "odd" } },
      { hooks: { PreToolUse: { matcher: "x" } } },
      { hooks: { PreToolUse: null } },
      { hooks: ["PreToolUse"] },
      { hooks: "none" },
      { hooks: null },
    ]) {
      const content = JSON.stringify(malformed);
      await writeFile(hooksPath, content);
      await expect(addCodexGuardHook(directory)).rejects.toThrow(
        "left unchanged",
      );
      expect(await readFile(hooksPath, "utf8")).toBe(content);
      expect(readdirSync(directory)).toEqual(["hooks.json"]);
    }
    // A hooks object without a PreToolUse list gets one.
    await writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [] } }));
    expect((await addCodexGuardHook(directory)).codexHookAdded).toBe(true);
    expect(JSON.parse(await readFile(hooksPath, "utf8")).hooks).toMatchObject({
      Stop: [],
      PreToolUse: [{ matcher: CODEX_GUARD_MATCHER }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
