export function assertTestIsolation(): void {
  if (process.env.SMART_ROUTER_TEST_PRELOAD !== String(process.pid))
    throw new Error(
      "Test isolation preload missing: run bun test from the repository root",
    );
}
assertTestIsolation();

export function restoreEnvironmentVariable(
  name: string,
  previous: string | undefined,
): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
