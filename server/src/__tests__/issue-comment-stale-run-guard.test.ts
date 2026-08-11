import { describe, expect, it } from "vitest";
import { isStaleRunIssueComment } from "../services/stale-run-comment.js";

// LUN-5207: `POST /api/issues/:id/comments` has no run-ownership guard, so a
// cancelled run whose process is still executing keeps writing on the thread
// while its successor works. The predicate below decides which comments lose
// their authority. It must catch the zombie and nothing else — a close-out
// comment is a run's main liveness path, so every ambiguous case fails OPEN.

const ZOMBIE = "11111111-1111-4111-8111-111111111111";
const SUCCESSOR = "22222222-2222-4222-8222-222222222222";

function verdict(overrides: Partial<Parameters<typeof isStaleRunIssueComment>[0]> = {}) {
  return isStaleRunIssueComment({
    actorRunId: ZOMBIE,
    checkoutRunId: SUCCESSOR,
    executionRunId: SUCCESSOR,
    authorRunStatus: "cancelled",
    checkoutRunStatus: "running",
    ...overrides,
  });
}

describe("isStaleRunIssueComment", () => {
  it("flags the measured LUN-5203 case: cancelled author, live successor holds the checkout", () => {
    expect(verdict()).toBe(true);
  });

  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "flags a %s author run",
    (authorRunStatus) => {
      expect(verdict({ authorRunStatus })).toBe(true);
    },
  );

  it.each(["queued", "running", "scheduled_retry"])(
    "leaves a %s author run authoritative",
    (authorRunStatus) => {
      expect(verdict({ authorRunStatus })).toBe(false);
    },
  );

  it("leaves the close-out comment of a run that still holds the checkout authoritative", () => {
    expect(verdict({ checkoutRunId: ZOMBIE, executionRunId: ZOMBIE })).toBe(false);
  });

  it("leaves the close-out comment authoritative when no successor holds the checkout", () => {
    expect(verdict({ checkoutRunId: null, executionRunId: null })).toBe(false);
    expect(verdict({ checkoutRunId: "  ", executionRunId: null })).toBe(false);
  });

  it("leaves the comment authoritative when the checkout holder is itself terminal", () => {
    // The lock is merely stale — nobody else is speaking for the issue, so
    // demoting this comment would silence the thread entirely.
    expect(verdict({ checkoutRunStatus: "failed" })).toBe(false);
  });

  it("keeps the designated executor's voice even when another run took the checkout row", () => {
    expect(verdict({ executionRunId: ZOMBIE })).toBe(false);
  });

  it("fails open when a run row is missing", () => {
    expect(verdict({ authorRunStatus: null })).toBe(false);
    expect(verdict({ checkoutRunStatus: null })).toBe(false);
  });

  it("fails open when the author has no run id", () => {
    expect(verdict({ actorRunId: null })).toBe(false);
    expect(verdict({ actorRunId: "   " })).toBe(false);
  });

  it("fails open on an unrecognised run status rather than guessing it is terminal", () => {
    expect(verdict({ authorRunStatus: "not_a_status" })).toBe(false);
  });
});
