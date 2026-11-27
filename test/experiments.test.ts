import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cryptoRandom,
  drawExperiments,
  repoContext,
  summarizeTrackedFiles,
} from "../src/experiments.ts";

test("draws each arm from its probability; 0 and 1 pin it", () => {
  const probabilities = { repoContext: 0.5, outcomeFeedback: 0.5 };
  expect(drawExperiments(probabilities, () => 0.49)).toEqual({
    repoContext: "on",
    outcomeFeedback: "on",
  });
  expect(drawExperiments(probabilities, () => 0.5)).toEqual({
    repoContext: "off",
    outcomeFeedback: "off",
  });
  for (let draw = 0; draw < 50; draw++)
    expect(
      drawExperiments({ repoContext: 0, outcomeFeedback: 1 }, cryptoRandom),
    ).toEqual({ repoContext: "off", outcomeFeedback: "on" });
  expect(drawExperiments({}, cryptoRandom)).toEqual({});
});

test("crypto randomness stays in [0, 1)", () => {
  for (let draw = 0; draw < 100; draw++) {
    const value = cryptoRandom();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
});

test("summarizes tracked files into a count, the top five extensions and a tests flag", () => {
  const paths = [
    ...Array.from({ length: 6 }, (_, index) => `src/file${index}.ts`),
    ...Array.from({ length: 5 }, (_, index) => `docs/page${index}.md`),
    "a.json",
    "b.json",
    "c.json",
    "d.yaml",
    "e.yaml",
    "f.toml",
    "g.css",
    "Makefile",
  ];
  expect(summarizeTrackedFiles(paths)).toEqual({
    trackedFiles: paths.length,
    topExtensions: [".ts", ".md", ".json", ".yaml", ".toml"],
    hasTests: false,
  });
  for (const testPath of [
    "test/route.test.ts",
    "tests/unit.py",
    "pkg/__tests__/a.js",
    "spec/model_spec.rb",
    "src/parser.spec.ts",
  ])
    expect(summarizeTrackedFiles([testPath]).hasTests).toBe(true);
  expect(summarizeTrackedFiles([])).toEqual({
    trackedFiles: 0,
    topExtensions: [],
    hasTests: false,
  });
});

test("reads repo context from git, and returns null outside a repository", async () => {
  const context = await repoContext(join(import.meta.dir, ".."));
  expect(context?.trackedFiles).toBeGreaterThan(20);
  expect(context?.topExtensions).toContain(".ts");
  expect(context?.hasTests).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), "smart-router-norepo-"));
  try {
    expect(await repoContext(directory)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
