import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { skill } from "./assets.ts";

const SKILL_DIRECTORY = "skills/smart-router";
const CODEX_INSTRUCTIONS =
  'Add this to your Codex AGENTS.md:\n\nDelegate coding tasks with `smart-router spawn "<prompt>" --cwd <repo>` and continue with `smart-router send <handle> "<message>"`.\n\n## Inside T3 Code\nWhen `delegate_task` is available, run `smart-router route "<task>" --launch --cwd <repo>` instead of spawn. Call `orchestrator_capabilities` once per thread for Claude/Codex provider instance IDs and model option names. Call `delegate_task` with `target.providerInstanceId` for `launch.harness`, `target.model` = `launch.model`, the effort entry in `target.options` = `launch.effort`, `task` = `launch.prompt`, and a short title. Use full-access runtime for network/full-access sandbox decisions, within parent permissions. Follow T3 rules for follow-ups. No smart-router handle or `send`, session record, or dashboard entry.';

export async function installSkill(
  stderr: (text: string) => void = console.error,
): Promise<string> {
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const skillPath = join(configDirectory, SKILL_DIRECTORY, "SKILL.md");
  await mkdir(join(configDirectory, SKILL_DIRECTORY), { recursive: true });
  await writeFile(skillPath, skill);
  stderr(`${CODEX_INSTRUCTIONS}\n`);
  return skillPath;
}
