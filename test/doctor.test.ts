import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { buildCandidates, type Detection } from "../src/doctor.ts";

test("builds candidates only for installed and authed harnesses", () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    models: [
      {
        id: "claude:opus",
        harness: "claude",
        model: "opus",
        efforts: ["high"],
      },
      {
        id: "codex:terra",
        harness: "codex",
        model: "terra",
        efforts: ["medium", "high"],
      },
    ],
  };
  const detection: Detection = {
    harnesses: {
      claude: { installed: true, version: "1", authed: true },
      codex: { installed: true, version: "1", authed: false },
      pi: { installed: false, version: null, authed: false },
    },
    providers: {},
    codexbar: { installed: false },
  };
  expect(buildCandidates(config, detection)).toEqual(["claude:opus@high"]);
});
