const targets = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
] as const;
const requestedTarget = process.argv[2];
const selectedTargets = requestedTarget
  ? targets.filter(([os, arch]) => `${os}-${arch}` === requestedTarget)
  : targets;
if (!selectedTargets.length)
  throw new Error(`Unknown target: ${requestedTarget}`);
for (const [os, arch] of selectedTargets) {
  const output = `dist/smart-router-${os}-${arch}`;
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      `--target=bun-${os}-${arch}`,
      "src/cli.ts",
      "--outfile",
      output,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
