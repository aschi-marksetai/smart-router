import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardrailsTemplate,
  preferencesInterviewTemplate,
  preferencesTemplate,
  skill,
} from "../src/assets.ts";
import { installSkill } from "../src/install.ts";

test("embedded assets are non-empty", () => {
  for (const asset of [
    preferencesTemplate,
    preferencesInterviewTemplate,
    guardrailsTemplate,
    skill,
  ])
    expect(asset.length).toBeGreaterThan(0);
});

test("install-skill writes the embedded skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  try {
    const path = await installSkill();
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(skill);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
