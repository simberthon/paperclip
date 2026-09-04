import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { isInertBlockedTransition } from "../services/recovery/blocked-unblock-path.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres LUN-7056 infra-failure tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The exact Claude Max session wall measured on 2026-09-04. */
const QUOTA_ERROR_TEXT =
  "Internal error: You've hit your session limit · resets 8:50pm (Asia/Bangkok)";

describeEmbeddedPostgres("LUN-7056 infrastructure failures preserve issue status", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-infra-failure-status-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(issueStatus: "todo" | "in_progress" = "in_progress") {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const prefix = `IF${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Infra Failure Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the infra-failure classifier",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { companyId, managerId, coderId, issueId, prefix, issue: issue! };
  }

  /**
   * Insert a terminal run whose `contextSnapshot.issueId` points at the issue, which is
   * how `countConsecutiveInfraFailures` finds the chain, and return it shaped like the
   * `latestRun` the reconciler hands to `escalateStrandedAssignedIssue`.
   */
  async function seedFailedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    errorCode: string;
    error: string;
    createdAt: Date;
  }) {
    const runId = randomUUID();
    const row = {
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "scheduled",
      status: "failed",
      error: input.error,
      errorCode: input.errorCode,
      livenessState: "needs_followup",
      contextSnapshot: { issueId: input.issueId },
      startedAt: input.createdAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    await db.insert(heartbeatRuns).values(row);
    return {
      id: runId,
      agentId: input.agentId,
      status: "failed",
      error: input.error,
      errorCode: input.errorCode,
      contextSnapshot: { issueId: input.issueId } as Record<string, unknown>,
      livenessState: "needs_followup",
      startedAt: input.createdAt,
      createdAt: input.createdAt,
    };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function readDeferralActivity(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(desc(activityLog.createdAt));
  }

  it("preserves in_progress and arms a wake when the latest run failed on a provider quota wall", async () => {
    const { companyId, coderId, issue } = await seedCompany("in_progress");
    const latestRun = await seedFailedRun({
      companyId,
      agentId: coderId,
      issueId: issue.id,
      errorCode: "acpx_turn_failed",
      error: QUOTA_ERROR_TEXT,
      createdAt: new Date(),
    });
    const before = Date.now();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    const row = await readIssue(issue.id);
    expect(row.status).toBe("in_progress");
    expect(row.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(new Date(row.monitorNextCheckAt!).getTime()).toBeGreaterThan(before);

    const deferrals = (await readDeferralActivity(issue.id))
      .filter((entry) => entry.action === "issue.infra_failure_deferred");
    expect(deferrals).toHaveLength(1);
    expect(deferrals[0]).toMatchObject({
      companyId,
      entityType: "issue",
      entityId: issue.id,
      runId: latestRun.id,
    });
    expect(deferrals[0]?.details).toMatchObject({
      preservedStatus: "in_progress",
      failureClass: "infra",
      failureReason: "provider_quota",
    });

    // The deferral is not an escalation: no blocked write, no recovery action.
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(actions).toHaveLength(0);
  });

  it("preserves todo, which the pre-LUN-7056 provider-quota monitor path bailed on", async () => {
    const { companyId, coderId, issue } = await seedCompany("todo");
    const latestRun = await seedFailedRun({
      companyId,
      agentId: coderId,
      issueId: issue.id,
      errorCode: "acpx_turn_failed",
      error: QUOTA_ERROR_TEXT,
      createdAt: new Date(),
    });
    const before = Date.now();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "todo",
      latestRun,
    });

    const row = await readIssue(issue.id);
    expect(row.status).toBe("todo");
    expect(row.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(new Date(row.monitorNextCheckAt!).getTime()).toBeGreaterThan(before);

    const deferrals = (await readDeferralActivity(issue.id))
      .filter((entry) => entry.action === "issue.infra_failure_deferred");
    expect(deferrals).toHaveLength(1);
    expect(deferrals[0]?.details).toMatchObject({ preservedStatus: "todo" });
  });

  it("still escalates a business failure to blocked, with a non-inert unblock path", async () => {
    const { companyId, coderId, issue } = await seedCompany("in_progress");
    const latestRun = await seedFailedRun({
      companyId,
      agentId: coderId,
      issueId: issue.id,
      errorCode: "agent_not_invokable",
      error: "The assigned agent has no invokable adapter configuration.",
      createdAt: new Date(),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    const row = await readIssue(issue.id);
    expect(row.status).toBe("blocked");

    const deferrals = (await readDeferralActivity(issue.id))
      .filter((entry) => entry.action === "issue.infra_failure_deferred");
    expect(deferrals).toHaveLength(0);

    // The escalated ticket must carry a live way out: a resolvable owner and an action.
    const descriptor = row.unblockDescriptor;
    expect(descriptor).not.toBeNull();
    expect(descriptor?.action).toBeTruthy();
    expect(descriptor?.owner).toBeTruthy();
    const owner = descriptor?.owner;
    if (owner !== "board") {
      expect(typeof owner === "object" && owner !== null && "agentId" in owner
        ? owner.agentId
        : null).toBeTruthy();
    }
    expect(row.blockedByIssueIds ?? []).toEqual([]);
    expect(isInertBlockedTransition({
      status: row.status,
      blockerIssueIds: [],
      unblockDescriptor: descriptor,
    })).toBe(false);
  });

  it("stops deferring once the consecutive infra-failure chain is exhausted", async () => {
    const { companyId, coderId, issue } = await seedCompany("in_progress");
    const base = Date.now() - 60 * 60_000;
    let latestRun = await seedFailedRun({
      companyId,
      agentId: coderId,
      issueId: issue.id,
      errorCode: "acpx_turn_failed",
      error: QUOTA_ERROR_TEXT,
      createdAt: new Date(base),
    });
    // Eight consecutive infra-classified failures — comfortably past the module-private
    // deferral ceiling, so the chain has to escalate rather than be re-armed forever.
    for (let index = 1; index < 8; index += 1) {
      latestRun = await seedFailedRun({
        companyId,
        agentId: coderId,
        issueId: issue.id,
        errorCode: "acpx_turn_failed",
        error: QUOTA_ERROR_TEXT,
        createdAt: new Date(base + index * 60_000),
      });
    }
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    const row = await readIssue(issue.id);
    expect(row.status).toBe("blocked");

    const deferrals = (await readDeferralActivity(issue.id))
      .filter((entry) => entry.action === "issue.infra_failure_deferred");
    expect(deferrals).toHaveLength(0);

    const descriptor = row.unblockDescriptor;
    expect(descriptor).not.toBeNull();
    expect(descriptor?.action).toBeTruthy();
    expect(isInertBlockedTransition({
      status: row.status,
      blockerIssueIds: [],
      unblockDescriptor: descriptor,
    })).toBe(false);
  });
});
