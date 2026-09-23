import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isNewerVersion,
  readUpdateNotice,
  updateExecutable,
  updateRefusal,
} from "../src/update.ts";

const state = join(process.cwd(), ".tmp-update-test");
afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  delete process.env.SMART_ROUTER_STATE_DIR;
});

test("compares semantic versions", () => {
  expect(isNewerVersion("1.9.9", "2.0.0")).toBe(true);
});
test("refuses Homebrew executables", () =>
  expect(updateRefusal("/Cellar/")).toMatch(/Homebrew/));
test("caches fresh checks and never throws", async () => {
  process.env.SMART_ROUTER_STATE_DIR = state;
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        tag_name: "v1.2.4",
        assets: [
          {
            name: `smart-router-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
            browser_download_url: "asset",
          },
        ],
      }),
      { status: 200 },
    );
  };
  expect((await readUpdateNotice("1.2.3", fetch))?.isNewer).toBe(true);
  expect((await readUpdateNotice("1.2.3", fetch))?.isNewer).toBe(true);
  expect(calls).toBe(1);
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "update.json"), "bad");
  expect(
    await readUpdateNotice("1.2.3", async () => {
      throw new Error("offline");
    }),
  ).toBeNull();
});
test("refuses a checksum mismatch", async () => {
  const path = join(state, "binary");
  await mkdir(state, { recursive: true });
  const fetch = async (url: string) =>
    url.endsWith("sha256")
      ? new Response("bad")
      : new Response(new Uint8Array([1, 2, 3]));
  await expect(
    updateExecutable(
      {
        latestVersion: "1.2.4",
        isNewer: true,
        assetUrl: "asset",
        checksumUrl: "asset.sha256",
      },
      path,
      fetch,
    ),
  ).rejects.toThrow("checksum");
});

test("refuses source executables and installs a verified update", async () => {
  expect(updateRefusal("/usr/local/bin/bun")).toMatch(/source/);
  const executablePath = join(state, "binary");
  await mkdir(state, { recursive: true });
  const bytes = new Uint8Array([1, 2, 3]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const fetchAsset = async (url: string) =>
    url.endsWith("sha256") ? new Response(checksum) : new Response(bytes);
  await updateExecutable(
    {
      latestVersion: "1.2.4",
      isNewer: true,
      assetUrl: "asset",
      checksumUrl: "asset.sha256",
    },
    executablePath,
    fetchAsset,
  );
  expect(new Uint8Array(await Bun.file(executablePath).arrayBuffer())).toEqual(
    bytes,
  );
});
