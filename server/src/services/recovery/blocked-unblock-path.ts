/**
 * LUN-7056 — no issue may enter `blocked` without a way back out.
 *
 * `POST/PATCH /api/issues/:id` already enforces this for every external caller:
 * routes/issues.ts refuses a blocked transition with 422 "Entering blocked requires
 * unresolved blockers, a pending interaction/approval, or unblockDescriptor".
 *
 * The recovery service does not go through that route. It calls `issuesSvc.update`
 * directly, so a run-failure escalation lands as `status=blocked` with `blockedBy: []`
 * and `unblockDescriptor: null` whenever the issue happens to have no blocker of its
 * own. Nothing can ever fire an unblock event for that state: `routable-blocked.ts`
 * needs a descriptor to notify an owner, and the dependency watcher needs a blocker
 * issue to watch. The ticket is inert until a human notices it by eye. Measured on
 * 2026-08-03, 2026-09-02 and 2026-09-04; on the last of those it took out 16 tickets.
 *
 * This module builds the descriptor the recovery paths must attach. It is pure so the
 * invariant can be tested without a database.
 */

import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export type UnblockPathInput = {
  /** Unresolved blocker issue ids that will be written alongside the status. */
  blockerIssueIds: readonly string[];
  /** A descriptor the caller already has a better answer for. Wins when present. */
  descriptor?: IssueUnblockDescriptor | null;
  /** Agent that owns getting this issue moving again, when there is one. */
  ownerAgentId?: string | null;
  /** Recovery action id, so the owner can resolve exactly the right action. */
  recoveryActionId?: string | null;
  /** Human-readable cause, used in the action text. */
  cause?: string | null;
};

export const RECOVERY_UNBLOCK_ACTION_FALLBACK =
  "This issue was blocked by an automated recovery escalation, not by a dependency. " +
  "Inspect the failed run, restore a live execution path, then move the issue out of `blocked`.";

function truncateAction(action: string): string {
  const trimmed = action.trim();
  // The validator caps `action` at 2000 characters; keep well inside it.
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 1_999)}…` : trimmed;
}

/**
 * Build the descriptor for a recovery-owned blocked transition.
 *
 * The owner is the recovery owner when the escalation named one, and the board
 * otherwise — the board is the only owner that is always resolvable, and an issue
 * whose recovery has no agent owner is precisely the one a human has to look at.
 */
export function buildRecoveryUnblockDescriptor(input: {
  ownerAgentId?: string | null;
  recoveryActionId?: string | null;
  cause?: string | null;
}): IssueUnblockDescriptor {
  const parts = [
    input.cause ? `Recovery cause: \`${input.cause}\`.` : null,
    RECOVERY_UNBLOCK_ACTION_FALLBACK,
    input.recoveryActionId ? `Recovery action: \`${input.recoveryActionId}\`.` : null,
  ].filter(Boolean) as string[];

  return {
    owner: input.ownerAgentId ? { agentId: input.ownerAgentId } : "board",
    action: truncateAction(parts.join(" ")),
  };
}

/**
 * Resolve the `unblockDescriptor` to write with a blocked transition.
 *
 * Returns `undefined` when the transition already has a real dependency to wait on —
 * in that case the blocker relations are the unblock path and a descriptor would only
 * add noise. Returns a descriptor in every other case, so the pair
 * (`blockedBy` empty, `unblockDescriptor` null) becomes unreachable from this seam.
 */
export function resolveUnblockDescriptorForBlockedTransition(
  input: UnblockPathInput,
): IssueUnblockDescriptor | undefined {
  if (input.descriptor) return input.descriptor;
  if (input.blockerIssueIds.length > 0) return undefined;
  return buildRecoveryUnblockDescriptor({
    ownerAgentId: input.ownerAgentId ?? null,
    recoveryActionId: input.recoveryActionId ?? null,
    cause: input.cause ?? null,
  });
}

/**
 * True when a blocked transition would land in the inert state this ticket exists to
 * make impossible. Used by the assertion in the recovery service and by the repair pass.
 */
export function isInertBlockedTransition(input: {
  status: string;
  blockerIssueIds: readonly string[];
  unblockDescriptor?: IssueUnblockDescriptor | null;
}): boolean {
  return input.status === "blocked" &&
    input.blockerIssueIds.length === 0 &&
    !input.unblockDescriptor;
}
