/**
 * LUN-7056 — classify why a run failed, so the platform can tell a *delay* from a *blocker*.
 *
 * A business blocker is a real dependency: the work cannot proceed until someone or
 * something else moves. `blocked` is the correct status for it, and a human or agent
 * owner is nameable.
 *
 * An infrastructure failure blocks nothing. The provider said no, the fleet was paused,
 * the adapter timed out, the process died. The work is unchanged and will proceed as
 * soon as the platform tries again. Writing `blocked` for that is a factually wrong
 * diagnosis, and — because the escalation path has no blocker issue and no unblock
 * descriptor to attach — it produces a ticket that nothing can ever wake.
 *
 * Measured three times before this module existed (2026-08-03, 2026-09-02, 2026-09-04).
 * On 2026-09-04 a single `You've hit your session limit` wall failed 25 runs across 11
 * issues in 30 minutes and left 16 tickets in `status=blocked` with `blockedBy: []` and
 * `unblockDescriptor: null`.
 *
 * This module is deliberately a pure function over the run record: no db, no clock
 * beyond the injected `now`, so it is cheap to unit-test and cheap to call on every
 * escalation.
 */

export const RUN_FAILURE_CLASSES = ["infra", "business"] as const;
export type RunFailureClass = (typeof RUN_FAILURE_CLASSES)[number];

export type RunFailureReason =
  /** provider refused for quota/usage/session-limit reasons */
  | "provider_quota"
  /** provider or upstream transport wobble: 429/503/529, overloaded, at capacity */
  | "transient_upstream"
  /** the adapter process died, was lost, or never came back */
  | "process_lost"
  /** the adapter could not open a session (acpx_session_init_failed and friends) */
  | "session_init_failed"
  /** the adapter or the run wall-clock timed out */
  | "adapter_timeout"
  /** the agent, the issue or the whole fleet is paused/held */
  | "fleet_paused"
  /** the run could not start because its workspace was unavailable or busy */
  | "workspace_unavailable"
  /** anything we cannot positively identify as infrastructure */
  | "business";

export type RunFailureClassification = {
  failureClass: RunFailureClass;
  reason: RunFailureReason;
  /**
   * Suggested delay before the platform should look at this issue again. `null` for
   * `business` — the caller decides, because a business blocker waits on a person.
   */
  retryAfterMs: number | null;
  /** Short, already-safe-to-log fragment naming what matched. Never the raw error. */
  evidence: string | null;
};

export type ClassifiableRun = {
  errorCode?: string | null;
  error?: string | null;
  resultJson?: unknown;
} | null | undefined;

/** Backoffs are per-reason: a quota wall is minutes-to-hours, a lost process is seconds. */
export const INFRA_RETRY_AFTER_MS: Record<Exclude<RunFailureReason, "business">, number> = {
  provider_quota: 15 * 60_000,
  transient_upstream: 2 * 60_000,
  process_lost: 60_000,
  session_init_failed: 75_000,
  adapter_timeout: 2 * 60_000,
  fleet_paused: 10 * 60_000,
  workspace_unavailable: 60_000,
};

/**
 * Error codes that are, on their own, proof of an infrastructure failure. Keep this
 * list closed and explicit: a code that merely *might* be infra belongs in the regex
 * pass below, where it has to also match the message, so that a genuinely ambiguous
 * failure falls through to `business` and keeps today's (safe) escalation behaviour.
 */
const INFRA_ERROR_CODES: ReadonlyMap<string, RunFailureReason> = new Map([
  ["provider_quota", "provider_quota"],
  ["codex_transient_upstream", "transient_upstream"],
  ["claude_transient_upstream", "transient_upstream"],
  ["codex_harness_crash", "process_lost"],
  ["process_lost", "process_lost"],
  ["acpx_session_init_failed", "session_init_failed"],
  ["timeout", "adapter_timeout"],
  ["codex_output_inactivity_monitor", "adapter_timeout"],
  ["issue_paused", "fleet_paused"],
  ["agent_paused", "fleet_paused"],
  ["workspace_busy", "workspace_unavailable"],
  ["workspace_unavailable", "workspace_unavailable"],
]);

/**
 * Error codes that are broad enough to carry either kind of failure. They are admitted
 * to `infra` only when the message also matches one of the patterns below. `adapter_failed`
 * and `acpx_turn_failed` are the two that matter in practice: every Claude Max quota kill
 * measured on this fleet arrives as `acpx_turn_failed` with the session-limit text.
 */
const AMBIGUOUS_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "acpx_turn_failed",
  "acpx_run_failed",
  "unknown",
]);

const QUOTA_RE =
  /(?:you(?:'|’)ve hit your (?:\w+ )?limit|(?:session|usage|weekly|rate|5-hour) limit(?: reached| exceeded)?|provider quota|quota (?:limit )?(?:exceeded|reset)|model (?:is )?at capacity|resource[_ ]exhausted)/i;
const TRANSIENT_RE =
  /(?:\boverloaded\b|\bservice unavailable\b|\bbad gateway\b|\bupstream (?:error|timeout)\b|\b(?:429|502|503|529)\b|temporarily unavailable|internal server error)/i;
const TIMEOUT_RE = /(?:\btimed? ?out\b|deadline exceeded|no output for|inactivity)/i;
const PROCESS_LOST_RE =
  /(?:\bENOENT\b|\bEPIPE\b|\bECONNRESET\b|spawn \w+ failed|process (?:exited|died|was killed)|killed by signal|SIGKILL|SIGTERM|worker unavailable|sandbox worker)/i;
const SESSION_INIT_RE = /(?:ACP_SESSION_INIT_FAILED|ensure_session|session init(?:ialisation|ialization)? failed)/i;
const FLEET_PAUSE_RE = /(?:fleet (?:is )?paused|agent (?:is )?paused|issue (?:is )?paused|execution (?:is )?paused|pause hold)/i;
const WORKSPACE_RE = /(?:workspace (?:is )?(?:busy|unavailable|locked)|worktree (?:is )?(?:busy|locked)|failed to (?:acquire|claim) (?:the )?workspace)/i;

/** Matched in order: the first hit wins, so the most specific pattern comes first. */
const MESSAGE_PATTERNS: ReadonlyArray<[RegExp, Exclude<RunFailureReason, "business">, string]> = [
  [QUOTA_RE, "provider_quota", "quota/session-limit message"],
  [SESSION_INIT_RE, "session_init_failed", "session-init message"],
  [FLEET_PAUSE_RE, "fleet_paused", "pause message"],
  [WORKSPACE_RE, "workspace_unavailable", "workspace-availability message"],
  [PROCESS_LOST_RE, "process_lost", "process-loss message"],
  [TRANSIENT_RE, "transient_upstream", "transient-upstream message"],
  [TIMEOUT_RE, "adapter_timeout", "timeout message"],
];

function readErrorFamily(resultJson: unknown): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const family = (resultJson as Record<string, unknown>).errorFamily;
  return typeof family === "string" && family.trim() ? family.trim() : null;
}

/**
 * `errorFamily` is the adapter's own verdict, set at the point of failure where the
 * provider response was still in hand. When present it outranks our text matching.
 */
const INFRA_ERROR_FAMILIES: ReadonlyMap<string, RunFailureReason> = new Map([
  ["provider_quota", "provider_quota"],
  ["transient_upstream", "transient_upstream"],
]);

const BUSINESS: RunFailureClassification = {
  failureClass: "business",
  reason: "business",
  retryAfterMs: null,
  evidence: null,
};

function infra(reason: Exclude<RunFailureReason, "business">, evidence: string): RunFailureClassification {
  return {
    failureClass: "infra",
    reason,
    retryAfterMs: INFRA_RETRY_AFTER_MS[reason],
    evidence,
  };
}

/**
 * Classify a failed run as an infrastructure delay or a business blocker.
 *
 * Fails **closed**: anything not positively identified as infrastructure is `business`,
 * which keeps the pre-LUN-7056 escalation behaviour. A misclassified business failure
 * would silently stop escalating a genuinely stuck ticket; a misclassified infra failure
 * only costs one extra scheduled wake.
 */
export function classifyRunFailureClass(run: ClassifiableRun): RunFailureClassification {
  if (!run) return BUSINESS;

  const errorCode = typeof run.errorCode === "string" ? run.errorCode.trim() : "";
  const family = readErrorFamily(run.resultJson);

  const familyReason = family ? INFRA_ERROR_FAMILIES.get(family) : undefined;
  if (familyReason && familyReason !== "business") {
    return infra(familyReason, `errorFamily=${family}`);
  }

  const codeReason = errorCode ? INFRA_ERROR_CODES.get(errorCode) : undefined;
  if (codeReason && codeReason !== "business") {
    return infra(codeReason, `errorCode=${errorCode}`);
  }

  // An unrecognised code is only classified from its message when the code itself is
  // one of the known-broad ones. That stops an unrelated failure whose text happens to
  // contain "timed out" from being demoted to a retry.
  if (!AMBIGUOUS_ERROR_CODES.has(errorCode)) return BUSINESS;

  const haystack = [run.error ?? "", typeof run.resultJson === "string" ? run.resultJson : safeJson(run.resultJson)]
    .filter(Boolean)
    .join("\n");
  if (!haystack) return BUSINESS;

  for (const [pattern, reason, evidence] of MESSAGE_PATTERNS) {
    if (pattern.test(haystack)) return infra(reason, `${evidence} on errorCode=${errorCode || "none"}`);
  }
  return BUSINESS;
}

function safeJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function isInfraRunFailure(run: ClassifiableRun): boolean {
  return classifyRunFailureClass(run).failureClass === "infra";
}
