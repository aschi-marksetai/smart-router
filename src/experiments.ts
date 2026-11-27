import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { extname } from "node:path";
import type { ExperimentName } from "./config.ts";

const RANDOM_RESOLUTION = 2 ** 32;
// Routing must not wait on a huge repository; past this the route goes without repo context.
export const REPO_CONTEXT_TIMEOUT_MS = 300;
const REPO_CONTEXT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOP_EXTENSION_COUNT = 5;
const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\./;

export type ExperimentArm = "on" | "off";
export type ExperimentArms = Partial<Record<ExperimentName, ExperimentArm>>;
export type RepoContext = {
  trackedFiles: number;
  topExtensions: string[];
  hasTests: boolean;
};

export function cryptoRandom(): number {
  return randomInt(RANDOM_RESOLUTION) / RANDOM_RESOLUTION;
}

// random() is in [0, 1), so a probability of 0 is always off and 1 is always on.
export function drawExperiments(
  probabilities: Partial<Record<ExperimentName, number>>,
  random: () => number,
): ExperimentArms {
  return Object.fromEntries(
    Object.entries(probabilities).map(([name, probability]) => [
      name,
      random() < probability ? "on" : "off",
    ]),
  );
}

export function summarizeTrackedFiles(paths: string[]): RepoContext {
  const extensionCounts = new Map<string, number>();
  for (const path of paths) {
    const extension = extname(path);
    if (extension)
      extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
  }
  return {
    trackedFiles: paths.length,
    topExtensions: [...extensionCounts]
      .sort(([, left], [, right]) => right - left)
      .slice(0, TOP_EXTENSION_COUNT)
      .map(([extension]) => extension),
    hasTests: paths.some((path) => TEST_PATH_PATTERN.test(path)),
  };
}

// null outside a git repository, without git, or when listing takes too long.
export function repoContext(cwd: string): Promise<RepoContext | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files"],
      {
        cwd,
        timeout: REPO_CONTEXT_TIMEOUT_MS,
        maxBuffer: REPO_CONTEXT_MAX_OUTPUT_BYTES,
      },
      (error, stdout) =>
        resolve(
          error
            ? null
            : summarizeTrackedFiles(stdout.split("\n").filter(Boolean)),
        ),
    );
  });
}
