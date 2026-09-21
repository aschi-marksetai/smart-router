import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";

export const RELEASES_URL =
  "https://api.github.com/repos/aschi-marksetai/smart-router/releases/latest";
export const UPDATE_CACHE_FILE_NAME = "update.json";
export const UPDATE_CACHE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export type UpdateResult = {
  latestVersion: string;
  isNewer: boolean;
  assetUrl: string;
  checksumUrl: string;
};
type FetchLike = (input: string) => Promise<Response>;
export function isNewerVersion(
  currentVersion: string,
  latestVersion: string,
): boolean {
  const current = currentVersion.split(".").map(Number);
  const latest = latestVersion.split(".").map(Number);
  const difference = latest.findIndex(
    (value, index) => value !== current[index],
  );
  return difference >= 0 && latest[difference] > current[difference];
}

export async function checkForUpdate({
  currentVersion,
  fetch,
}: {
  currentVersion: string;
  fetch: FetchLike;
}): Promise<UpdateResult> {
  const response = await fetch(RELEASES_URL);
  if (!response.ok) throw new Error(`Release check failed: ${response.status}`);
  const release = (await response.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const latestVersion = release.tag_name?.replace(/^v/, "");
  if (!latestVersion || !VERSION_PATTERN.test(latestVersion))
    throw new Error("Invalid release version");
  const assetName = `smart-router-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const asset = release.assets?.find(({ name }) => name === assetName);
  if (!asset) throw new Error("Release asset unavailable");
  return {
    latestVersion,
    isNewer: isNewerVersion(currentVersion, latestVersion),
    assetUrl: asset.browser_download_url,
    checksumUrl: `${asset.browser_download_url}.sha256`,
  };
}

export async function readUpdateNotice(
  currentVersion = "0.0.0",
  fetch: FetchLike = globalThis.fetch,
): Promise<UpdateResult | null> {
  const cachePath = join(stateDir(), UPDATE_CACHE_FILE_NAME);
  try {
    const cached = JSON.parse(
      await fs.readFile(cachePath, "utf8"),
    ) as UpdateResult;
    const cacheAge = Date.now() - (await fs.stat(cachePath)).mtimeMs;
    if (cacheAge < UPDATE_CACHE_INTERVAL_MS) return cached;
  } catch {}
  try {
    const result = await checkForUpdate({ currentVersion, fetch });
    await fs.mkdir(dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(result));
    return result;
  } catch {
    return null;
  }
}

export function updateRefusal(executablePath: string): string | null {
  if (executablePath.includes("/Cellar/"))
    return "installed by Homebrew; run brew upgrade smart-router";
  if (executablePath.endsWith("/bun") || executablePath.endsWith("/bun.exe"))
    return "running from source; git pull instead";
  return null;
}

export async function updateExecutable(
  result: UpdateResult,
  executablePath: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<void> {
  const [assetResponse, checksumResponse] = await Promise.all([
    fetch(result.assetUrl),
    fetch(result.checksumUrl),
  ]);
  if (!assetResponse.ok || !checksumResponse.ok)
    throw new Error("Could not download update");
  const bytes = Buffer.from(await assetResponse.arrayBuffer());
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Update checksum mismatch");
  const temporaryPath = `${executablePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, bytes, { mode: 0o755 });
  await fs.chmod(temporaryPath, 0o755);
  await fs.rename(temporaryPath, executablePath);
}
