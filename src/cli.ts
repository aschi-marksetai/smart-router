#!/usr/bin/env bun
import { Command } from "commander";
import { type HarnessName, loadConfig } from "./config.ts";
import { doctor } from "./doctor.ts";
import { loadDotEnv } from "./env.ts";
import { getAdapter } from "./harness/index.ts";
import { runInit } from "./init.ts";
import { getQuota } from "./quota.ts";
import { configDir } from "./paths.ts";
import { guardrailsFor, loadGuardrails } from "./guardrails.ts";
import {
  defaultRouteDeps,
  needsStoppingPoint,
  route,
  type RouteOptions,
} from "./route.ts";
import { createSession, loadSession } from "./sessions.ts";

const ERROR_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const HARNESS_NAMES: HarnessName[] = ["claude", "codex", "pi"];

type SpawnOptions = RouteOptions & {
  model?: string;
  effort?: string;
  worktree?: boolean;
  guardrails?: boolean;
};
type Pick = { harness: HarnessName; model: string; effort: string };

function printResult(
  result: unknown,
  summary: string,
  exitCode = SUCCESS_EXIT_CODE,
): never {
  console.log(JSON.stringify(result));
  console.error(summary);
  process.exit(exitCode);
}

function isHarness(value: string): value is HarnessName {
  return HARNESS_NAMES.some((harness) => harness === value);
}

function parseHarness(modelId: string): [HarnessName, string] {
  const modelSeparator = modelId.indexOf(":");
  if (modelSeparator < 1) throw new Error("Model must be harness:model");
  const harness = modelId.slice(0, modelSeparator);
  if (!isHarness(harness)) throw new Error(`Unknown harness: ${harness}`);
  return [harness, modelId.slice(modelSeparator + 1)];
}

function parsePick(value: string): Pick {
  const effortSeparator = value.lastIndexOf("@");
  if (effortSeparator < 1)
    throw new Error("Model must be harness:model@effort");
  const [harness, model] = parseHarness(value.slice(0, effortSeparator));
  return {
    harness,
    model,
    effort: value.slice(effortSeparator + 1),
  };
}

function directPick(modelId: string, effort: string): Pick {
  const [harness, model] = parseHarness(modelId);
  return { harness, model, effort };
}

async function routeCommand(
  prompt: string,
  options: RouteOptions,
): Promise<never> {
  const config = await loadConfig();
  const result = await route(prompt, options, defaultRouteDeps(config));
  return printResult(
    result,
    options.dryRun ? "Route dry run completed" : "Route selected",
  );
}

async function spawnCommand(
  prompt: string,
  options: SpawnOptions,
): Promise<never> {
  const config = await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const routeResult = options.model
    ? null
    : await route(prompt, options, defaultRouteDeps(config));
  if (routeResult && !("pick" in routeResult))
    throw new Error("Cannot spawn from a dry-run route");
  let selected: Pick;
  if (options.model) {
    selected = directPick(
      options.model,
      options.effort ?? config.defaultEffort,
    );
  } else {
    if (!routeResult) throw new Error("Route result is missing");
    selected = parsePick(routeResult.pick);
  }
  if (routeResult && needsStoppingPoint(config, routeResult)) {
    const modelId = routeResult.pick.split("@", 1)[0];
    throw new Error(
      `${modelId} needs a stated stopping point: add success criteria and where to stop to the prompt, then call spawn again`,
    );
  }
  const guardrails =
    options.guardrails === false
      ? ""
      : guardrailsFor(
          await loadGuardrails(),
          `${selected.harness}:${selected.model}`,
        );
  const spawnPrompt = guardrails
    ? `${prompt}\n\n## Operating rules\n\n${guardrails}`
    : prompt;
  const adapter = getAdapter(selected.harness);
  const spawned = await adapter.spawn(spawnPrompt, {
    cwd,
    model: selected.model,
    effort: selected.effort,
    worktree: options.worktree,
    claudePermissionMode: config.spawn.claudePermissionMode,
    codexSandbox: config.spawn.codexSandbox,
  });
  const session = await createSession({
    ...selected,
    cwd,
    sessionId: spawned.sessionId,
    prompt: spawnPrompt,
  });
  return printResult(
    {
      handle: session.handle,
      ...selected,
      route: routeResult,
      resumeCommand: spawned.resumeCommand,
      result: spawned.result,
    },
    "Spawn completed",
  );
}

async function sendCommand(handle: string, message: string): Promise<never> {
  const [config, session] = await Promise.all([
    loadConfig(),
    loadSession(handle),
  ]);
  const response = await getAdapter(session.harness).resume(
    session.sessionId,
    message,
    {
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      claudePermissionMode: config.spawn.claudePermissionMode,
      codexSandbox: config.spawn.codexSandbox,
    },
  );
  return printResult({ handle, result: response.result }, "Message sent");
}

async function main(): Promise<void> {
  await loadDotEnv(configDir());
  await loadDotEnv(process.cwd());
  const program = new Command().name("smart-router");
  program
    .command("doctor")
    .action(async () =>
      printResult(await doctor(await loadConfig()), "Doctor completed"),
    );
  program
    .command("init")
    .option("--section <section>")
    .option("--reset")
    .action(runInit);
  program
    .command("route <prompt>")
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .action(routeCommand);
  program
    .command("spawn <prompt>")
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--worktree")
    .option("--no-guardrails")
    .action(spawnCommand);
  program.command("send <handle> <message>").action(sendCommand);
  program.command("quota").action(async () => {
    const result = await getQuota();
    return printResult(
      result,
      "Quota retrieved",
      "error" in result ? ERROR_EXIT_CODE : SUCCESS_EXIT_CODE,
    );
  });
  await program.parseAsync();
}

main().catch((error: unknown) =>
  printResult(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof Error ? error.message : String(error),
    ERROR_EXIT_CODE,
  ),
);
