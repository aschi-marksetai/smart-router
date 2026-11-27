import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { skill } from "./assets.ts";
import { isMissingFile, record } from "./files.ts";
import { codexHomeDir } from "./paths.ts";

const SKILL_DIRECTORY = "skills/smart-router";
const SKILL_FILE = "SKILL.md";
const CODEX_HOOKS_FILE = "hooks.json";
// Codex names its native subagent tool spawn_agent and also matches it as Agent.
export const CODEX_GUARD_MATCHER = "^(spawn_agent|Agent)$";
export const CODEX_GUARD_COMMAND = "smart-router guard subagent --hook codex";
const GUARD_HOOK_TIMEOUT_SECONDS = 6;

export type InstallResult = {
  skillPath: string;
  codexSkillPath: string;
  codexHooksPath: string;
  codexHookAdded: boolean;
  codexHooksBackup: string | null;
};

async function writeSkill(directory: string): Promise<string> {
  const skillPath = join(directory, SKILL_DIRECTORY, SKILL_FILE);
  await mkdir(join(directory, SKILL_DIRECTORY), { recursive: true });
  await writeFile(skillPath, skill);
  return skillPath;
}

// Adds the native-subagent guard to Codex's hooks file. Running it again changes nothing,
// and a file that is about to change is copied aside first.
export async function addCodexGuardHook(
  codexHome: string,
  now: Date = new Date(),
): Promise<
  Pick<InstallResult, "codexHooksPath" | "codexHookAdded" | "codexHooksBackup">
> {
  const codexHooksPath = join(codexHome, CODEX_HOOKS_FILE);
  const existing = await readFile(codexHooksPath, "utf8").catch(
    (error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    },
  );
  const settings = existing === null ? {} : record(JSON.parse(existing));
  if (!settings)
    throw new Error(`${codexHooksPath} is not a JSON object; left unchanged`);
  // Checked before the backup or any write: an unexpected shape is the user's to fix, not ours to replace.
  // Only a missing key counts as empty; null or any other value is malformed.
  const hooks = settings.hooks === undefined ? {} : record(settings.hooks);
  if (!hooks)
    throw new Error(
      `${codexHooksPath}: "hooks" is not a JSON object; left unchanged`,
    );
  const preToolUse = hooks.PreToolUse === undefined ? [] : hooks.PreToolUse;
  if (!Array.isArray(preToolUse))
    throw new Error(
      `${codexHooksPath}: "hooks.PreToolUse" is not a list; left unchanged`,
    );
  const alreadyInstalled = preToolUse.some((entry) => {
    const entryHooks = record(entry)?.hooks;
    return (
      Array.isArray(entryHooks) &&
      entryHooks.some((hook) => record(hook)?.command === CODEX_GUARD_COMMAND)
    );
  });
  if (alreadyInstalled)
    return { codexHooksPath, codexHookAdded: false, codexHooksBackup: null };
  const codexHooksBackup =
    existing === null
      ? null
      : `${codexHooksPath}.bak-${now.toISOString().replace(/\D/g, "")}`;
  if (codexHooksBackup) await copyFile(codexHooksPath, codexHooksBackup);
  await mkdir(codexHome, { recursive: true });
  // Written in place, not renamed over, so a hooks.json that is a symlink stays one.
  await writeFile(
    codexHooksPath,
    `${JSON.stringify(
      {
        ...settings,
        hooks: {
          ...hooks,
          PreToolUse: [
            ...preToolUse,
            {
              matcher: CODEX_GUARD_MATCHER,
              hooks: [
                {
                  type: "command",
                  command: CODEX_GUARD_COMMAND,
                  timeout: GUARD_HOOK_TIMEOUT_SECONDS,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return { codexHooksPath, codexHookAdded: true, codexHooksBackup };
}

export async function installSkill(
  stderr: (text: string) => void = console.error,
): Promise<InstallResult> {
  const skillPath = await writeSkill(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  );
  const codexSkillPath = await writeSkill(codexHomeDir());
  const codexHook = await addCodexGuardHook(codexHomeDir());
  const backupNote = codexHook.codexHooksBackup
    ? ` (previous file saved as ${codexHook.codexHooksBackup})`
    : "";
  stderr(
    [
      `Codex: skill installed at ${codexSkillPath}; invoke it as $smart-router.`,
      codexHook.codexHookAdded
        ? `Codex: native-subagent guard hook added to ${codexHook.codexHooksPath}${backupNote}. Restart Codex and approve the hook with /hooks; until then it does not run.`
        : `Codex: native-subagent guard hook already in ${codexHook.codexHooksPath}.`,
      "Claude Code: the smart-router-threads plugin carries the same guard for the Agent tool.",
      "",
    ].join("\n"),
  );
  return { skillPath, codexSkillPath, ...codexHook };
}
