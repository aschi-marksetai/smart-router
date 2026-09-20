import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { Config, HarnessName } from "./config.ts";

const CODEX_API_KEY_ENV = "CODEX_API_KEY";
const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json");
const CLAUDE_CATALOG_GLOB = join(
  homedir(),
  ".claude",
  "cache",
  "model-catalog",
  "*.json",
);
const CODEXBAR_BINARY = "codexbar";

export type HarnessDetection = {
  installed: boolean;
  version: string | null;
  authed: boolean;
};
export type Detection = {
  harnesses: Record<HarnessName, HarnessDetection>;
  providers: Record<string, { apiKeySet: boolean }>;
  codexbar: { installed: boolean };
};
export type DoctorResult = Detection & { candidates: string[] };

async function commandOutput(
  command: string,
  ...arguments_: string[]
): Promise<string | null> {
  try {
    const output = await $`${command} ${arguments_}`.quiet();
    return output.text().trim();
  } catch {
    return null;
  }
}

async function isInstalled(binary: string): Promise<boolean> {
  return (await commandOutput("command", "-v", binary)) !== null;
}

async function detectHarness(
  name: HarnessName,
  config: Config,
): Promise<HarnessDetection> {
  const installed = await isInstalled(name);
  const version = installed ? await commandOutput(name, "--version") : null;
  const providerKeySet = Object.values(config.providers).some(({ apiKeyEnv }) =>
    Boolean(process.env[apiKeyEnv]),
  );
  if (name === "claude")
    return {
      installed,
      version,
      authed: globSync(CLAUDE_CATALOG_GLOB).length > 0,
    };
  if (name === "codex")
    return {
      installed,
      version,
      authed:
        existsSync(CODEX_MODELS_CACHE) ||
        Boolean(process.env[CODEX_API_KEY_ENV]),
    };
  const authed = providerKeySet;
  return { installed, version, authed };
}

export function buildCandidates(
  config: Config,
  detection: Detection,
): string[] {
  return config.models.flatMap(({ id, harness, efforts }) => {
    const detectedHarness = detection.harnesses[harness];
    return detectedHarness.installed && detectedHarness.authed
      ? efforts.map((effort) => `${id}@${effort}`)
      : [];
  });
}

export async function doctor(config: Config): Promise<DoctorResult> {
  const [claude, codex, pi] = await Promise.all([
    detectHarness("claude", config),
    detectHarness("codex", config),
    detectHarness("pi", config),
  ]);
  const harnesses = { claude, codex, pi };
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([name, { apiKeyEnv }]) => [
      name,
      { apiKeySet: Boolean(process.env[apiKeyEnv]) },
    ]),
  );
  const codexbar = { installed: await isInstalled(CODEXBAR_BINARY) };
  const detection = { harnesses, providers, codexbar };
  return { ...detection, candidates: buildCandidates(config, detection) };
}
