import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { skill } from "./assets.ts";

const SKILL_DIRECTORY = "skills/smart-router";
const CODEX_INSTRUCTIONS =
  'Add this to your Codex AGENTS.md:\n\nDelegate coding tasks with `smart-router spawn "<prompt>" --cwd <repo>` and continue with `smart-router send <handle> "<message>"`.';

export async function installSkill(): Promise<string> {
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const skillPath = join(configDirectory, SKILL_DIRECTORY, "SKILL.md");
  await mkdir(join(configDirectory, SKILL_DIRECTORY), { recursive: true });
  await writeFile(skillPath, skill);
  console.error(CODEX_INSTRUCTIONS);
  return skillPath;
}
