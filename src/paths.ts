import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_ENVIRONMENT_VARIABLE = "SMART_ROUTER_CONFIG_DIR";
const STATE_ENVIRONMENT_VARIABLE = "SMART_ROUTER_STATE_DIR";
const CONFIG_DIRECTORY_PARTS = [".config", "smart-router"];
const STATE_DIRECTORY_PARTS = [".local", "state", "smart-router"];
const SESSIONS_DIRECTORY_NAME = "sessions";

export function configDir(): string {
  return (
    process.env[CONFIG_ENVIRONMENT_VARIABLE] ??
    join(homedir(), ...CONFIG_DIRECTORY_PARTS)
  );
}

export function stateDir(): string {
  return (
    process.env[STATE_ENVIRONMENT_VARIABLE] ??
    join(homedir(), ...STATE_DIRECTORY_PARTS)
  );
}

export function sessionsDir(): string {
  return join(stateDir(), SESSIONS_DIRECTORY_NAME);
}

const CODEX_HOME_ENVIRONMENT_VARIABLE = "CODEX_HOME";
const CODEX_HOME_DIRECTORY_NAME = ".codex";

export function codexHomeDir(): string {
  return (
    process.env[CODEX_HOME_ENVIRONMENT_VARIABLE] ??
    join(homedir(), CODEX_HOME_DIRECTORY_NAME)
  );
}
