// Kept local so this module has no service-layer imports (see the note on
// `isStaleRunIssueComment` below). Mirrors the same list in
// `services/heartbeat.ts` and `TERMINAL_HEARTBEAT_RUN_STATUSES` in
// `services/issues.ts`; `HEARTBEAT_RUN_STATUSES` in `@paperclipai/shared` is
// the full enum these are drawn from.
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

/**
 * Whether an issue comment is being written by a *stale* run (LUN-5207).
 *
 * A cancelled/failed run's process can keep executing for tens of seconds after
 * the orchestrator marked it terminal, and `POST /issues/:id/comments` has no
 * run-ownership guard (unlike `/interactions`). The zombie then keeps talking on
 * the thread while its successor works — contradictory comments that read as the
 * issue's current voice, plus an extra heartbeat wake each (LUN-4107).
 *
 * Refusing the write is not safe: the close-out comment is a run's main liveness
 * path, so a legitimate run whose lock was adopted would lose its final report.
 * This predicate instead identifies only the unambiguous zombie case, so callers
 * can accept the write but strip its authority (de-emphasised rendering, no
 * status steering, no wake).
 *
 * Deliberately fails OPEN — every unknown (missing run row, unknown status, no
 * successor) returns false and leaves the comment fully authoritative.
 *
 * Lives in its own module rather than in `services/issues.ts` so the route
 * tests that `vi.mock` the whole issue service still exercise the real rule.
 */
export function isStaleRunIssueComment(input: {
  actorRunId: string | null | undefined;
  checkoutRunId: string | null | undefined;
  executionRunId: string | null | undefined;
  authorRunStatus: string | null | undefined;
  checkoutRunStatus: string | null | undefined;
}) {
  const isTerminal = (status: string | null | undefined) =>
    typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
  const actorRunId = typeof input.actorRunId === "string" ? input.actorRunId.trim() : "";
  if (!actorRunId) return false;
  const checkoutRunId = typeof input.checkoutRunId === "string" ? input.checkoutRunId.trim() : "";
  // No successor holds the lock, or the author still holds it: nobody else is
  // speaking for the issue, so the comment is the current voice by definition.
  if (!checkoutRunId || checkoutRunId === actorRunId) return false;
  // The designated executor keeps its voice even when another run took the
  // checkout row, so an in-flight execution never gets demoted.
  if (input.executionRunId === actorRunId) return false;
  // Only a run the orchestrator already ended is a zombie.
  if (!isTerminal(input.authorRunStatus)) return false;
  // ...and only while a live successor actually holds the checkout. A terminal
  // holder means the lock is merely stale, not contested.
  if (!input.checkoutRunStatus || isTerminal(input.checkoutRunStatus)) return false;
  return true;
}
