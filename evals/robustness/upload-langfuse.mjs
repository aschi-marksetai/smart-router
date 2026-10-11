import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const datasetName = "smart-router-robustness";
const environment = "eval";
const outputLimitBytes = 4 * 1024;
const millisecondsPerSecond = 1000;
const traceIdLength = 32;
const externalParentSpanId = "0000000000000001";
const sampledTraceFlag = 1;
const passValues = { PASS: 1, PARTIAL: 0.5, FAIL: 0 };
const credentialNames = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];
export const scenarioTimeouts = {
  "self-wait": 180,
  "stop-parent": 180,
  "max-depth": 180,
  "yield-trap": 300,
  "capacity-flood": 240,
  "give-up": 180,
  cascade: 180,
  "send-to-running": 180,
  "steer-nested": 240,
  "wait-forever": 420,
  "kill-caller": 180,
};
const expectedBehaviours = {
  "self-wait": "Own-handle wait refused with exit 1; delegate reports instead.",
  "stop-parent": "Stopping an ancestor is refused.",
  "max-depth":
    "Helper spawn beyond depth refused with capacity maxDepth; delegate does the work.",
  "yield-trap": "Parent reports the helper's final number, not an early yield.",
  "capacity-flood":
    "Spawns beyond the per-caller cap exit 3; parent waits or stops before retrying.",
  "give-up":
    "Helper stopped after the deadline; parent reports partial progress.",
  cascade: "Stopping a parent leaves no helper running.",
  "send-to-running": "Send to a running helper refused; parent waits.",
  "steer-nested": "Helper replies steered.",
  "wait-forever":
    "Parent waits with --timeout polling and returns the helper result.",
  "kill-caller": "No session stays running and no harness process survives.",
};
const identifier = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, traceIdLength);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function truncateOutput(value) {
  let output = String(value ?? "").slice(0, outputLimitBytes);
  while (Buffer.byteLength(output) > outputLimitBytes)
    output = output.slice(0, -1);
  return output;
}

function sessionObservation(session, result) {
  const parent = session.depth === 1;
  const startTime = session.createdAt;
  const endTime = session.endedAt ?? null;
  const observation = {
    name: `${session.handle} ${session.harness}:${session.model}@${session.effort}`,
    type: "span",
    startTime,
    endTime,
    metadata: {
      depth: session.depth,
      status: session.status,
      exitCode: session.exitCode ?? null,
      codes: session.codesAppeared ?? null,
      error: session.error ?? null,
      commands: (result.actions ?? []).filter((action) =>
        action.argv?.includes(session.handle),
      ),
      endTimeRecorded: endTime !== null,
    },
  };
  if (parent) {
    observation.metadata.exitCode = result.parentExitCode ?? null;
    observation.metadata.exitCodeKind = result.parentExitKind;
    observation.metadata.codes = result.codesAppeared ?? null;
    observation.metadata.timedOut = result.timedOut;
  }
  if (!session.usage) return observation;
  observation.type = "generation";
  observation.model = session.model;
  observation.usageDetails = {
    input: session.usage.inputTokens,
    output: session.usage.outputTokens,
  };
  if (session.usage.costUsd !== null)
    observation.costDetails = { total: session.usage.costUsd };
  return observation;
}

async function buildPlan(runDirectory) {
  const [aggregate, packageMetadata, grading] = await Promise.all([
    readJson(join(runDirectory, "results.json")),
    readJson(join(directory, "../../package.json")),
    readJson(join(runDirectory, "graded.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const runDate = basename(runDirectory);
  assert.match(runDate, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  const runStartTime = runDate.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const version = packageMetadata.version;
  const runName = `smart-router-${version}-${runDate}`;
  assert.ok(Array.isArray(aggregate.results) && aggregate.results.length);
  assert.equal(
    new Set(aggregate.results.map((result) => result.scenario)).size,
    aggregate.results.length,
    "Duplicate scenarios in results.json",
  );
  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  const items = [];
  const traces = [];
  for (const summary of aggregate.results) {
    const { scenario } = summary;
    assert.ok(Object.hasOwn(expectedBehaviours, scenario), "Unknown scenario");
    assert.ok(Object.hasOwn(passValues, summary.outcome), "Unknown outcome");
    let evidence = summary;
    if (!summary.reason?.startsWith("SKIPPED:"))
      evidence = await readJson(join(runDirectory, `${scenario}.json`));
    const verdict = grading?.scenarios?.[scenario];
    if (grading) {
      assert.ok(verdict, `Missing grade for ${scenario}`);
      assert.ok(
        Object.hasOwn(passValues, verdict.outcome),
        "Unknown grade outcome",
      );
      assert.equal(typeof verdict.reason, "string", "Grade reason missing");
      assert.equal(
        typeof verdict.recovered,
        "boolean",
        "Grade recovery missing",
      );
      assert.ok(
        Number.isInteger(verdict.orphanedProcesses) &&
          verdict.orphanedProcesses >= 0,
        "Invalid grade orphan count",
      );
      assert.ok(
        Object.hasOwn(verdict, "smartRouterBug"),
        "Grade bug finding missing",
      );
    }
    const result = { ...evidence, ...summary, ...verdict };
    const recovered = verdict?.recovered ?? result.modelRecovery;
    assert.equal(evidence.scenario, scenario);
    const prompt =
      result.parentLaunch?.argv?.[2] ??
      (await readFile(join(directory, `${scenario}.md`), "utf8")).replaceAll(
        "{{HELPER_MODEL}}",
        aggregate.helperModel,
      );
    assert.equal(typeof prompt, "string", "Scenario prompt missing");
    const timeoutSeconds = scenarioTimeouts[scenario];
    assert.ok(Number.isFinite(timeoutSeconds), "Scenario timeout missing");
    items.push({
      id: scenario,
      datasetName,
      input: prompt,
      expectedOutput: expectedBehaviours[scenario],
      metadata: { timeoutSeconds },
    });
    counts[result.outcome]++;
    const observations = (result.rawSessions ?? []).map((session) =>
      sessionObservation(session, result),
    );
    const parentSession = result.rawSessions?.find(
      (session) => session.depth === 1,
    );
    const parentModelIndex = result.parentLaunch?.argv?.indexOf("--model");
    const parentModel = parentSession
      ? `${parentSession.harness}:${parentSession.model}`
      : result.parentLaunch?.argv?.[parentModelIndex + 1];
    const traceId = identifier(`${runName}/${scenario}`);
    const processEvidence = result.processesBeforeCleanup;
    const observedOrphans = (processEvidence?.recordedPids ?? []).filter(
      (process) => process.alive === true,
    ).length;
    const scores = [
      { name: "pass", dataType: "NUMERIC", value: passValues[result.outcome] },
      { name: "outcome", dataType: "CATEGORICAL", value: result.outcome },
      {
        name: "orphaned_processes",
        dataType: "NUMERIC",
        value: verdict?.orphanedProcesses ?? observedOrphans,
        comment:
          "Observed live tracked PIDs before controller cleanup; incomplete inspection cannot rule out unrecorded processes.",
      },
    ];
    if (typeof recovered === "boolean")
      scores.push({
        name: "recovered",
        dataType: "BOOLEAN",
        value: Number(recovered),
      });
    if (verdict)
      scores.push({
        name: "smart_router_bug",
        dataType: "BOOLEAN",
        value: Number(verdict.smartRouterBug !== null),
      });
    traces.push({
      traceId,
      datasetItemId: scenario,
      name: `robustness/${scenario}`,
      sessionId: runName,
      environment,
      release: version,
      tags: ["smart-router", "robustness", parentModel].filter(Boolean),
      input: prompt,
      output: {
        outcome: result.outcome,
        reason: result.reason,
        parentResult: truncateOutput(result.parentResult),
      },
      startTime: parentSession?.createdAt ?? runStartTime,
      endTime: parentSession?.endedAt ?? null,
      metadata: {
        endTimeRecorded: parentSession?.endedAt != null,
        processInspectionAvailable:
          processEvidence?.inspectionAvailable ?? false,
        unknownRecordedProcesses: (processEvidence?.recordedPids ?? []).filter(
          (process) => typeof process.alive !== "boolean",
        ).length,
        modelRecovery: recovered ?? null,
        codes: result.codesAppeared ?? null,
        actions: result.actions ?? [],
      },
      observations,
      scores: scores.map((score) => ({
        ...score,
        comment: verdict?.reason ?? score.comment,
        id: identifier(`${traceId}/${score.name}`),
        traceId,
        environment,
      })),
    });
  }
  const tableCell = (value) =>
    String(value ?? "unknown")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const resultsTable = [
    "| Scenario | Outcome | Reason |",
    "| --- | --- | --- |",
    ...traces.map(
      (trace) =>
        `| ${trace.datasetItemId} | ${trace.output.outcome} | ${tableCell(trace.output.reason)} |`,
    ),
  ].join("\n");
  traces.push({
    traceId: identifier(`${runName}/summary`),
    name: "robustness/summary",
    sessionId: runName,
    environment,
    release: version,
    tags: ["smart-router", "robustness"],
    output: resultsTable,
    startTime: runStartTime,
    endTime: new Date(
      Date.parse(runStartTime) + aggregate.wallSeconds * millisecondsPerSecond,
    ).toISOString(),
    metadata: { counts },
    observations: [],
    scores: [],
  });
  return {
    dataset: { name: datasetName },
    run: {
      name: runName,
      description: `${counts.PASS} PASS, ${counts.PARTIAL} PARTIAL, ${counts.FAIL} FAIL`,
    },
    items,
    traces,
    traceCount: traces.length,
  };
}

async function step(name, operation) {
  try {
    return await operation();
  } catch (error) {
    const status = error.statusCode ?? error.status ?? error.code ?? "unknown";
    throw new Error(
      `step ${name} failed: ${status} ${error.message ?? error}`,
      {
        cause: error.cause,
      },
    );
  }
}

export async function upload(plan, credentials) {
  const [
    { LangfuseClient },
    { configureGlobalLogger, LogLevel },
    tracing,
    otel,
    sdk,
  ] = await Promise.all([
    import("@langfuse/client"),
    import("@langfuse/core"),
    import("@langfuse/tracing"),
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-node"),
  ]);
  configureGlobalLogger({ level: LogLevel.ERROR });
  const client = new LangfuseClient(credentials);
  const processor = new otel.LangfuseSpanProcessor({
    ...credentials,
    environment,
    release: plan.traces[0].release,
    additionalHeaders: { "x-langfuse-ingestion-version": "4" },
  });
  const provider = new sdk.NodeTracerProvider({ spanProcessors: [processor] });
  tracing.setLangfuseTracerProvider(provider);
  const spanAttributes = tracing.LangfuseOtelSpanAttributes;
  const datasetItems = new Map();
  let dataset;
  let experimentId;
  try {
    dataset = await step("dataset-get", async () => {
      try {
        return await client.api.datasets.get(datasetName);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        return null;
      }
    });
    dataset ??= await step("dataset-create", () =>
      client.api.datasets.create(plan.dataset),
    );
    experimentId = identifier(`${dataset.id}/${plan.run.name}`);
    for (const item of plan.items) {
      const datasetItem = await step(`dataset-item/${item.id}`, () =>
        client.api.datasetItems.create(item),
      );
      datasetItems.set(item.id, datasetItem);
    }
    for (const trace of plan.traces) {
      const {
        traceId,
        observations,
        scores,
        datasetItemId,
        startTime,
        endTime,
        ...attributes
      } = trace;
      const root = await step(`trace/${trace.name}`, () => {
        const observation = tracing.startObservation(trace.name, attributes, {
          startTime: new Date(startTime),
          parentSpanContext: {
            traceId,
            spanId: externalParentSpanId,
            traceFlags: sampledTraceFlag,
          },
        });
        return observation.updateTrace(attributes);
      });
      const sharedAttributes = {
        name: trace.name,
        sessionId: trace.sessionId,
        environment: trace.environment,
        release: trace.release,
        tags: trace.tags,
      };
      const experimentAttributes = {};
      if (datasetItemId) {
        await step(`experiment-item/${datasetItemId}`, () => {
          const item = datasetItems.get(datasetItemId);
          Object.assign(experimentAttributes, {
            [spanAttributes.EXPERIMENT_ID]: experimentId,
            [spanAttributes.EXPERIMENT_NAME]: plan.run.name,
            [spanAttributes.EXPERIMENT_DATASET_ID]: dataset.id,
            [spanAttributes.EXPERIMENT_ITEM_ID]: item.id,
            [spanAttributes.EXPERIMENT_ITEM_ROOT_OBSERVATION_ID]: root.id,
          });
          root.otelSpan.setAttributes({
            ...experimentAttributes,
            [spanAttributes.EXPERIMENT_DESCRIPTION]: plan.run.description,
            [spanAttributes.EXPERIMENT_ITEM_EXPECTED_OUTPUT]: JSON.stringify(
              item.expectedOutput,
            ),
            [spanAttributes.EXPERIMENT_ITEM_METADATA]: JSON.stringify(
              item.metadata,
            ),
          });
        });
      }
      for (const observation of observations) {
        const { name, type, startTime, endTime, ...attributes } = observation;
        await step(`observation/${trace.name}/${name}`, () => {
          const child = tracing.startObservation(name, attributes, {
            asType: type,
            startTime: new Date(startTime),
            parentSpanContext: root.otelSpan.spanContext(),
          });
          child.updateTrace(sharedAttributes);
          child.otelSpan.setAttributes(experimentAttributes);
          child.end(new Date(endTime ?? startTime));
        });
      }
      await step(`trace-end/${trace.name}`, () =>
        root.end(new Date(endTime ?? startTime)),
      );
      for (const score of scores)
        await step(`score/${datasetItemId}/${score.name}`, () =>
          client.api.score.create({ ...score, observationId: root.id }),
        );
    }
  } finally {
    try {
      await step("otel-flush", () => processor.forceFlush());
    } finally {
      const shutdownResults = await Promise.allSettled([
        step("client-shutdown", () => client.shutdown()),
        step("otel-shutdown", () => provider.shutdown()),
      ]);
      const failure = shutdownResults.find(
        (result) => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    }
  }
  console.log(
    `${credentials.baseUrl}/project/${dataset.projectId}/datasets/${dataset.id}/runs/${experimentId}`,
  );
  console.log(`Traces: ${plan.traceCount}`);
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const dryRun = argumentsList.includes("--dry-run");
  const runDirectories = argumentsList.filter(
    (argument) => argument !== "--dry-run",
  );
  assert.ok(
    runDirectories.length === 1 && !runDirectories[0].startsWith("--"),
    "Usage: bun evals/robustness/upload-langfuse.mjs <run-directory> [--dry-run]",
  );
  const missingCredentials = credentialNames.filter(
    (name) => !process.env[name]?.trim(),
  );
  assert.ok(
    dryRun || !missingCredentials.length,
    `Missing credentials: ${missingCredentials.join(", ")}`,
  );
  const plan = await buildPlan(resolve(runDirectories[0]));
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await upload(plan, {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL.replace(/\/$/, ""),
  });
}

if (import.meta.main)
  main().catch((error) => {
    const secretValues = credentialNames
      .map((name) => process.env[name])
      .filter((value) => value && value.length > 8);
    const errorPrefix = error?.message?.startsWith("step ")
      ? ""
      : `Langfuse upload failed: ${error?.name ?? "Error"}: `;
    const rawMessage = `${errorPrefix}${error?.message ?? String(error)}${error?.cause ? ` (cause: ${error.cause?.message ?? error.cause})` : ""}`;
    const redactedMessage = secretValues.reduce(
      (message, secret) => message.replaceAll(secret, "[redacted]"),
      rawMessage,
    );
    console.error(redactedMessage);
    process.exitCode = 1;
  });
