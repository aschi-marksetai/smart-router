import { expect, test } from "bun:test";
import {
  RECENT_OUTCOMES_WINDOW_MS,
  recentModelOutcomes,
  retriesByOriginal,
  RERUN_WINDOW_MS,
  sessionOutcome,
} from "../src/outcomes.ts";
import type { Session } from "../src/sessions.ts";

const START = Date.parse("2026-11-27T00:00:00Z");

function session(overrides: Partial<Session>): Session {
  return {
    handle: "first",
    harness: "codex",
    model: "sol",
    effort: "high",
    cwd: "/repo",
    owner: "owner",
    createdAt: new Date(START).toISOString(),
    promptPreview: "task",
    promptSha256: "hash",
    status: "done",
    ...overrides,
  };
}

test("derives status, retries, follow-up sends and rating from the record", () => {
  const turn = { startedAt: "", endedAt: "", idleSeconds: null, usage: null };
  const first = session({
    status: "failed",
    rating: { value: "bad", note: null, at: "" },
    turns: [
      { ...turn, kind: "routed" },
      { ...turn, kind: "resumed" },
      { ...turn, kind: "resumed" },
    ],
  });
  const second = session({
    handle: "second",
    retryOf: "first",
    promptSha256: "other",
  });
  // Without the retry on record, the first attempt does not count as retried.
  expect(sessionOutcome(first, [first]).retried).toBe(false);
  expect(sessionOutcome(first, [first, second])).toEqual({
    status: "failed",
    failed: true,
    retried: true,
    followUpSends: 2,
    rating: "bad",
    rerun: false,
  });
  expect(sessionOutcome(session({}), [])).toEqual({
    status: "done",
    failed: false,
    retried: false,
    followUpSends: 0,
    rating: null,
    rerun: false,
  });
});

test("flags a manual rerun: the same prompt started again within a day without retry", () => {
  const first = session({});
  const later = (offsetMs: number, overrides: Partial<Session> = {}) =>
    session({
      handle: "later",
      createdAt: new Date(START + offsetMs).toISOString(),
      ...overrides,
    });
  const rerun = (other: Session) => sessionOutcome(first, [first, other]).rerun;
  expect(rerun(later(60_000))).toBe(true);
  expect(rerun(later(RERUN_WINDOW_MS))).toBe(true);
  expect(rerun(later(RERUN_WINDOW_MS + 1))).toBe(false);
  // An earlier run of the same prompt is not a rerun of this one.
  expect(rerun(later(-60_000))).toBe(false);
  expect(rerun(later(60_000, { promptSha256: "other" }))).toBe(false);
  // A linked retry is counted as retried, not as a manual rerun.
  expect(rerun(later(60_000, { retryOf: "first" }))).toBe(false);
  // Nor is a second retry of some earlier attempt a rerun of this one.
  expect(rerun(later(60_000, { retryOf: "an-earlier-attempt" }))).toBe(false);
  const unhashed = session({ promptSha256: undefined });
  expect(
    sessionOutcome(unhashed, [
      unhashed,
      later(60_000, { promptSha256: undefined }),
    ]).rerun,
  ).toBe(false);
});

test("counts each candidate model's recent runs, failures, retries and ratings", () => {
  const now = START + 60_000;
  const failed = session({ handle: "a", status: "failed" });
  const escalation = session({
    handle: "b",
    harness: "claude",
    model: "opus",
    retryOf: "a",
    escalated: true,
    rating: { value: "good", note: null, at: "" },
  });
  const rated = session({
    handle: "c",
    rating: { value: "bad", note: null, at: "" },
  });
  const old = session({
    handle: "d",
    createdAt: new Date(now - RECENT_OUTCOMES_WINDOW_MS - 1).toISOString(),
  });
  expect(
    recentModelOutcomes(
      [failed, escalation, rated, old],
      ["codex:sol", "claude:opus", "codex:luna"],
      now,
    ),
  ).toEqual({
    "codex:sol": {
      runs: 2,
      failed: 1,
      retried: 1,
      escalatedFrom: 1,
      ratedGood: 0,
      ratedBad: 1,
    },
    "claude:opus": {
      runs: 1,
      failed: 0,
      retried: 0,
      escalatedFrom: 0,
      ratedGood: 1,
      ratedBad: 0,
    },
    "codex:luna": {
      runs: 0,
      failed: 0,
      retried: 0,
      escalatedFrom: 0,
      ratedGood: 0,
      ratedBad: 0,
    },
  });
});

test("retriedBy is derived from the retries' retryOf, oldest first, ignoring any stored copy", () => {
  const original = {
    ...session({ handle: "original" }),
    // Left on disk by an older version; no session points back at these.
    retriedBy: ["stale"],
  };
  const later = session({
    handle: "later",
    retryOf: "original",
    createdAt: new Date(START + 2_000).toISOString(),
  });
  const earlier = session({
    handle: "earlier",
    retryOf: "original",
    createdAt: new Date(START + 1_000).toISOString(),
  });
  const unrelated = session({ handle: "unrelated", retryOf: "other" });
  const sessions = [original, later, earlier, unrelated];
  const retries = retriesByOriginal(sessions);
  expect(retries.get("original")).toEqual(["earlier", "later"]);
  expect(retries.get("later")).toBeUndefined();
  expect([...retries.keys()].sort()).toEqual(["original", "other"]);
  // A retry written without touching the original still counts: there is no second write to lose.
  expect(sessionOutcome(original, sessions).retried).toBe(true);
  expect(sessionOutcome(original, [original]).retried).toBe(false);
});
