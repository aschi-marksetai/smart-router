import type { HarnessName } from "../config.ts";
import * as claude from "./claude.ts";
import * as codex from "./codex.ts";
import * as pi from "./pi.ts";

const ADAPTERS = { claude, codex, pi };

export function getAdapter(harness: HarnessName) {
  return ADAPTERS[harness];
}
