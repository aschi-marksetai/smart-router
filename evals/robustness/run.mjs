// Live only: bun evals/robustness/run.mjs [scenario ...] [--upload] (never bun test/CI).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioTimeouts } from "./upload-langfuse.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(directory, "../..");
const configDirectory = join(homedir(), ".config/smart-router");
const totalBudgetMs = 45 * 60 * 1000;
const cleanupReserveMs = 30 * 1000;
const resultLimit = 3000;
const parentModel = "codex:gpt-6.1-sol";
const lunaModel = "codex:gpt-6-luna";
const haikuModel = "claude:claude-haiku-4-5-20251001";
const scenarios = Object.entries(scenarioTimeouts);
const pause = (milliseconds) => Bun.sleep(milliseconds);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM" ? "unknown: EPERM" : false;
  }
};

function launch(argv, env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const completion = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({
    argv,
    pid: child.pid,
    exitCode,
    signal: child.signalCode,
    stdout,
    stderr,
  }));
  return { child, completion };
}

async function command(argv, env) {
  let timer;
  try {
    const { child, completion } = launch(argv, env);
    timer = setTimeout(() => child.kill("SIGKILL"), cleanupReserveMs);
    return await completion;
  } catch (error) {
    return {
      argv,
      pid: null,
      exitCode: null,
      stdout: "",
      stderr: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function rawSessions(stateDirectory) {
  const sessionDirectory = join(stateDirectory, "sessions");
  const names = await readdir(sessionDirectory).catch(() => []);
  const contents = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        readFile(join(sessionDirectory, name), "utf8")
          .then(parse)
          .catch(() => null),
      ),
  );
  return contents.filter(Boolean);
}

async function hashes() {
  const entries = await Promise.all(
    ["config.json", "preferences.md", "guardrails.md", ".env"].map(
      async (name) => {
        const contents = await readFile(join(configDirectory, name)).catch(
          () => null,
        );
        return [
          name,
          contents === null
            ? null
            : createHash("sha256").update(contents).digest("hex"),
        ];
      },
    ),
  );
  return Object.fromEntries(entries);
}

async function processes(recordedPids, env) {
  const [pgrep, ps] = await Promise.all([
    command(["pgrep", "-fl", "codex|claude"], env),
    command(["ps", "-axo", "pid=,ppid=,stat=,comm="], env),
  ]);
  const rows = ps.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parentPid, status, ...name] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parentPid: Number(parentPid),
        status,
        name: name.join(" "),
      };
    });
  const tracked = new Set(recordedPids);
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (tracked.has(row.parentPid) && !tracked.has(row.pid)) {
        tracked.add(row.pid);
        added = true;
      }
    }
  }
  return {
    inspectionAvailable:
      ps.exitCode === 0 && pgrep.exitCode <= 1 && !pgrep.stderr,
    psError: ps.stderr,
    pgrepError: pgrep.stderr,
    recordedPids: [...tracked].map((pid) => ({ pid, alive: alive(pid) })),
    descendants: rows.filter((row) => tracked.has(row.pid)),
    harnessMatches: pgrep.stdout
      .split("\n")
      .filter((line) => tracked.has(Number(line.split(" ")[0]))),
  };
}

function environment(stateDirectory) {
  const env = { ...process.env };
  for (const key of [
    "SMART_ROUTER_HANDLE",
    "SMART_ROUTER_ANCESTORS",
    "SMART_ROUTER_DEPTH",
    "SMART_ROUTER_OWNER",
  ])
    delete env[key];
  return {
    ...env,
    SMART_ROUTER_CONFIG_DIR: configDirectory,
    SMART_ROUTER_STATE_DIR: stateDirectory,
    SMART_ROUTER_NO_UPDATE_CHECK: "1",
    SMART_ROUTER_DEPTH: "0",
    SMART_ROUTER_OWNER: stateDirectory,
  };
}

async function runScenario(name, budgetSeconds, helperModel, deadline) {
  const started = Date.now();
  const stateDirectory = await mkdtemp(
    join(tmpdir(), `smart-router-robustness-${name}-`),
  );
  const env = environment(stateDirectory);
  const actions = [];
  const recordedPids = new Set();
  const template = await readFile(join(directory, `${name}.md`), "utf8");
  const prompt = `Live adversarial robustness scenario ${name}. Work only in ${cwd}. Never edit repository files or the real router config. Preserve SMART_ROUTER_STATE_DIR and SMART_ROUTER_NO_UPDATE_CHECK in all commands. Helpers must use --model ${lunaModel} --effort low --sandbox danger-full-access, except the explicitly selected steering helper. Always pass --cwd ${cwd}. Record each smart-router command's exit code and JSON in your report, including refusals, capacity, and timeouts. Never switch to a more expensive model. Do not bypass CLI safeguards by changing delegation environment variables.\n\n${template.replaceAll("{{HELPER_MODEL}}", helperModel)}`;
  const detached = name === "cascade";
  const argv = [
    "smart-router",
    "spawn",
    prompt,
    "--cwd",
    cwd,
    "--model",
    parentModel,
    "--effort",
    "low",
    "--sandbox",
    "danger-full-access",
    "--result-limit",
    String(resultLimit),
  ];
  if (detached) argv.push("--detach");
  const outer = launch(argv, env);
  let parentExit = null;
  outer.completion.then((result) => {
    parentExit = result;
  });
  const scenarioDeadline = Math.min(
    started + budgetSeconds * 1000,
    deadline - cleanupReserveMs,
  );
  let intervention = false;
  let timedOut = false;
  let observedProcesses = null;
  while (Date.now() < scenarioDeadline) {
    const sessions = await rawSessions(stateDirectory);
    for (const session of sessions) {
      if (session.pid) recordedPids.add(session.pid);
    }
    const parent = sessions.find((session) => session.depth === 1);
    const helper = sessions.find(
      (session) =>
        session.depth === 2 && session.status === "running" && session.pid,
    );
    if (
      !intervention &&
      parent &&
      helper &&
      (name === "cascade" || name === "kill-caller")
    ) {
      // Observe the running descendant before stopping/killing its caller.
      observedProcesses = await processes([...recordedPids], env);
      if (name === "cascade")
        actions.push(
          await command(["smart-router", "stop", parent.handle], env),
        );
      else {
        outer.child.kill("SIGKILL");
        actions.push({
          action: "kill -9 outer smart-router",
          pid: outer.child.pid,
        });
      }
      intervention = true;
      await pause(6000);
      break;
    }
    if (parentExit && (!detached || parentExit.exitCode !== 0)) break;
    if (detached && parent && parent.status !== "running") break;
    if (detached && parentExit && parent && alive(parent.pid) === false) break;
    await pause(1000);
  }
  if (Date.now() >= scenarioDeadline && !intervention) timedOut = true;
  if (detached) {
    const parent = (await rawSessions(stateDirectory)).find(
      (session) => session.depth === 1,
    );
    if (parent)
      actions.push(
        await command(
          [
            "smart-router",
            "wait",
            parent.handle,
            "--timeout",
            "0",
            "--result-limit",
            String(resultLimit),
          ],
          env,
        ),
      );
  }
  const beforeCleanup = await command(
    ["smart-router", "sessions", "--all"],
    env,
  );
  const sessions = await rawSessions(stateDirectory);
  for (const session of sessions)
    if (session.pid) recordedPids.add(session.pid);
  const beforeProcesses = await processes([...recordedPids], env);
  const cleanup = [];
  for (const session of sessions) {
    if (
      session.status === "running" ||
      (session.pid && alive(session.pid) !== false)
    )
      cleanup.push(
        await command(["smart-router", "stop", session.handle], env),
      );
  }
  if (!parentExit) outer.child.kill("SIGTERM");
  await pause(1500);
  for (const { pid, alive: running } of beforeProcesses.recordedPids) {
    if (!running || alive(pid) === false) continue;
    try {
      process.kill(pid, "SIGKILL");
      cleanup.push({ action: "SIGKILL", pid });
    } catch (error) {
      cleanup.push({ action: "SIGKILL", pid, error: error.message });
    }
  }
  if (!parentExit) outer.child.kill("SIGKILL");
  parentExit = await outer.completion;
  const afterCleanup = await command(
    ["smart-router", "sessions", "--all"],
    env,
  );
  const afterProcesses = await processes([...recordedPids], env);
  const parent = sessions.find((session) => session.depth === 1);
  const finalOutput = parse(parentExit.stdout);
  const waitResult = actions.find((action) => action.argv?.[1] === "wait");
  const text =
    finalOutput?.result ??
    parent?.lastResult ??
    parent?.result ??
    finalOutput?.error ??
    "No parent result";
  const combined = JSON.stringify({ parentExit, actions, sessions });
  const blocked =
    /Operation not permitted|failed to initialize in-process app-server/.test(
      combined,
    );
  const leakedHarness = beforeProcesses.harnessMatches.length > 0;
  let outcome = "PARTIAL";
  const failed =
    timedOut || leakedHarness || (parentExit.exitCode !== 0 && !intervention);
  if (!blocked && beforeProcesses.inspectionAvailable && failed)
    outcome = "FAIL";
  return {
    scenario: name,
    outcome,
    reason: blocked
      ? "Environment blocked harness initialization; adversarial actions not reached"
      : "Review actual model actions and results; a zero parent exit alone is not a pass",
    stateDirectory,
    wallSeconds: (Date.now() - started) / 1000,
    parentExitCode: detached
      ? (waitResult?.exitCode ?? null)
      : parentExit.exitCode,
    parentExitKind: detached
      ? "smart-router wait observation (not raw harness exit)"
      : "outer foreground smart-router",
    parentResult: text.slice(0, resultLimit),
    parentLaunch: parentExit,
    codesAppeared: {
      refusal: /refusing to/.test(combined),
      capacity: /"capacity"/.test(combined),
      timeout: /"timeout"/.test(combined),
      environmentFailure: blocked,
    },
    modelRecovery: blocked
      ? "Not exercised: model did not start"
      : "See parentResult and logs",
    timedOut,
    intervention,
    actions,
    sessionsBeforeCleanup: parse(beforeCleanup.stdout),
    rawSessions: sessions,
    observedProcesses,
    processesBeforeCleanup: beforeProcesses,
    cleanup,
    sessionsAfterCleanup: parse(afterCleanup.stdout),
    processesAfterCleanup: afterProcesses,
  };
}

const uploadRequested = process.argv.includes("--upload");
const selectedNames = process.argv
  .slice(2)
  .filter((name) => name !== "--upload");
assert.equal(new Set(scenarios.map(([name]) => name)).size, 11);
for (const [name] of scenarios)
  assert.ok(
    (await readFile(join(directory, `${name}.md`), "utf8")).includes(
      "stop there",
    ),
  );
if (selectedNames.includes("--check")) {
  console.log(
    "Runner self-check passed: eleven unique, readable scenario prompts with stopping points.",
  );
  process.exit(0);
}
for (const name of selectedNames)
  assert.ok(
    scenarios.some(([scenario]) => scenario === name),
    `Unknown scenario: ${name}`,
  );
const configBefore = await hashes();
const config = JSON.parse(
  await readFile(join(configDirectory, "config.json"), "utf8"),
);
for (const model of [parentModel, lunaModel])
  assert.ok(
    config.models.some(
      (entry) =>
        entry.id === model &&
        entry.efforts.includes("low") &&
        config.harnesses[entry.harness]?.enabled,
    ),
    `${model}@low must be enabled`,
  );
const helperModel = config.models.some(
  (entry) =>
    entry.id === haikuModel &&
    entry.efforts.includes("low") &&
    config.harnesses.claude?.enabled,
)
  ? haikuModel
  : lunaModel;
const runDirectory = join(
  directory,
  "runs",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(runDirectory, { recursive: true });
const version = await command(["smart-router", "--version"], process.env);
assert.equal(version.stdout.trim(), "0.5.0");
const deadline = Date.now() + totalBudgetMs;
const results = [];
for (const [name, seconds] of scenarios) {
  if (selectedNames.length && !selectedNames.includes(name)) continue;
  if (Date.now() + seconds * 1000 + cleanupReserveMs > deadline) {
    results.push({
      scenario: name,
      outcome: "PARTIAL",
      reason: "SKIPPED: remaining 45-minute budget insufficient",
    });
    continue;
  }
  console.log(`START ${name}`);
  const result = await runScenario(name, seconds, helperModel, deadline);
  results.push(result);
  await writeFile(
    join(runDirectory, `${name}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    `END ${name}: ${result.outcome}; exit=${result.parentExitCode}; ${result.wallSeconds.toFixed(1)}s; ${result.reason}`,
  );
}
const configAfter = await hashes();
const metadata = {
  version: version.stdout.trim(),
  cwd,
  helperModel,
  concurrency: config.rules.concurrency,
  configUnchanged: JSON.stringify(configBefore) === JSON.stringify(configAfter),
  configBefore,
  configAfter,
  results,
  wallSeconds: (Date.now() - deadline + totalBudgetMs) / 1000,
};
await writeFile(
  join(runDirectory, "results.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
await writeFile(join(directory, "latest-run.txt"), runDirectory + "\n");
console.log(
  `Evidence: ${runDirectory}; config unchanged: ${metadata.configUnchanged}`,
);
assert.ok(metadata.configUnchanged, "Real config files changed during the run");
const uploadCredentialsPresent = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
].every((name) => process.env[name]?.trim());
if (uploadRequested && uploadCredentialsPresent) {
  const uploader = Bun.spawn(
    [process.execPath, join(directory, "upload-langfuse.mjs"), runDirectory],
    { cwd, env: process.env, stdout: "inherit", stderr: "inherit" },
  );
  assert.equal(await uploader.exited, 0, "Langfuse upload failed");
}
if (uploadRequested && !uploadCredentialsPresent)
  console.log(
    "Langfuse upload skipped: all three LANGFUSE credentials are required.",
  );
