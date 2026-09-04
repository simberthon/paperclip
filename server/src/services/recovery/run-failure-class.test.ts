import { describe, expect, it } from "vitest";
import {
  INFRA_RETRY_AFTER_MS,
  classifyRunFailureClass,
  isInfraRunFailure,
} from "./run-failure-class.js";

describe("classifyRunFailureClass", () => {
  it("classifies the measured Claude Max session-limit wall as infra", () => {
    // Verbatim shape of the 25 runs that failed between 17:04Z and 17:35Z on
    // 2026-09-04 and left 16 tickets falsely blocked.
    const result = classifyRunFailureClass({
      errorCode: "acpx_turn_failed",
      error: "Internal error: You've hit your session limit · resets 8:50pm (Asia/Bangkok)",
      resultJson: {},
    });
    expect(result.failureClass).toBe("infra");
    expect(result.reason).toBe("provider_quota");
    expect(result.retryAfterMs).toBe(INFRA_RETRY_AFTER_MS.provider_quota);
  });

  it("trusts the adapter's own errorFamily over the message text", () => {
    const result = classifyRunFailureClass({
      errorCode: "adapter_failed",
      error: "no useful text here",
      resultJson: { errorFamily: "provider_quota" },
    });
    expect(result.failureClass).toBe("infra");
    expect(result.reason).toBe("provider_quota");
    expect(result.evidence).toBe("errorFamily=provider_quota");
  });

  it.each([
    ["provider_quota", "provider_quota"],
    ["process_lost", "process_lost"],
    ["acpx_session_init_failed", "session_init_failed"],
    ["timeout", "adapter_timeout"],
    ["codex_harness_crash", "process_lost"],
    ["claude_transient_upstream", "transient_upstream"],
    ["issue_paused", "fleet_paused"],
    ["workspace_busy", "workspace_unavailable"],
  ])("classifies errorCode %s as infra/%s on the code alone", (errorCode, reason) => {
    const result = classifyRunFailureClass({ errorCode, error: null, resultJson: null });
    expect(result.failureClass).toBe("infra");
    expect(result.reason).toBe(reason);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it.each([
    ["session limit", "You've hit your session limit", "provider_quota"],
    ["usage limit", "usage limit reached, try again later", "provider_quota"],
    ["weekly limit", "weekly limit exceeded", "provider_quota"],
    ["capacity", "the model is at capacity right now", "provider_quota"],
    ["overloaded", "Error: upstream overloaded (529)", "transient_upstream"],
    ["timeout", "request timed out after 600s", "adapter_timeout"],
    ["spawn", "spawn claude failed: ENOENT", "process_lost"],
    ["pause", "execution is paused for this agent", "fleet_paused"],
    ["workspace", "failed to acquire the workspace lock", "workspace_unavailable"],
  ])("reads %s out of an ambiguous acpx_turn_failed message", (_label, error, reason) => {
    const result = classifyRunFailureClass({ errorCode: "acpx_turn_failed", error, resultJson: null });
    expect(result.failureClass).toBe("infra");
    expect(result.reason).toBe(reason);
  });

  it("fails closed: an unknown error code is business even when the text looks infra", () => {
    const result = classifyRunFailureClass({
      errorCode: "agent_declined_scope",
      error: "the agent timed out waiting for the human to answer",
      resultJson: null,
    });
    expect(result.failureClass).toBe("business");
    expect(result.retryAfterMs).toBeNull();
  });

  it.each([
    "agent_not_invokable",
    "budget_exhausted",
    "issue_dependencies_blocked",
    "configuration_incomplete",
    "workspace_validation_failed",
  ])("keeps %s in the business class so it still escalates", (errorCode) => {
    expect(classifyRunFailureClass({ errorCode, error: "…", resultJson: null }).failureClass)
      .toBe("business");
  });

  it("classifies a missing run and an empty message as business", () => {
    expect(classifyRunFailureClass(null).failureClass).toBe("business");
    expect(classifyRunFailureClass(undefined).failureClass).toBe("business");
    expect(classifyRunFailureClass({ errorCode: "acpx_turn_failed", error: "", resultJson: null }).failureClass)
      .toBe("business");
  });

  it("never returns a null backoff for an infra class", () => {
    const infra = classifyRunFailureClass({ errorCode: "provider_quota", error: null, resultJson: null });
    expect(infra.retryAfterMs).not.toBeNull();
    expect(isInfraRunFailure({ errorCode: "provider_quota" })).toBe(true);
    expect(isInfraRunFailure({ errorCode: "agent_not_found" })).toBe(false);
  });

  it("survives an unserialisable resultJson without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => classifyRunFailureClass({ errorCode: "acpx_turn_failed", error: null, resultJson: circular }))
      .not.toThrow();
  });
});
