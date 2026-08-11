import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const RESPONSIBLE_USER_ID = "00000000-0000-4000-8000-000000005210";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping zombie execution-lock leak tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * LUN-5210 — per-issue run lock.
 *
 * Production incident (LUN-3702, 2026-07-26 00:05-00:13 BKK, paperclipai
 * 2026.722.0): three runs of the same agent were live on one issue at the same
 * time. Timeline from heartbeat_runs:
 *
 *   00:05:14  a4855260 issue_monitor_due        started (later: error_code=process_lost)
 *   00:07:07  9a20222a issue_children_completed started while a4855260 still "running"
 *   00:07:14  fba74da3 issue_monitor_due        started while both still "running"
 *
 * Mechanism: when the run holding issues.executionRunId is "running" in the DB
 * but absent from the in-process liveRunExecutions set (its process died and the
 * periodic reaper has not marked it lost yet), filterZombieCoalesceTarget nulls
 * the coalesce target. Both the coalesce branch AND the defer branch are guarded
 * by that same nulled value, so the wake falls through and inserts a fresh run —
 * correct in itself. The defect is that the zombie keeps holding the lock:
 * claimQueuedRun's stamp is guarded by
 * `executionRunId IS NULL OR executionRunId = <new run>`, so it silently updates
 * 0 rows and issues.executionRunId still points at the zombie. Every subsequent
 * wake therefore repeats the same fall-through and leaks another run — the leak
 * is unbounded, not one-shot.
 *
 * Correct behaviour: the FIRST wake takes the lock over from the zombie (one new
 * run — the zombie is dead, the issue must keep moving). Every wake after that
 * must coalesce or defer against the new holder, never spawn a third run.
 */
describeEmbeddedPostgres("issue execution lock — zombie holder must not leak unbounded runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-zombie-lock-leak-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // These wakes dispatch for real and the test host has no adapter, so a run
    // can still be mid-flight here. TRUNCATE ... CASCADE tears every fixture
    // down in one statement regardless of FK order or in-flight writes.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "CTO") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /**
   * Reproduces the incident state: an issue whose execution lock is held by a
   * run that is "running" in the DB but has no live execution in this process.
   * `heartbeatService(db)` is a fresh service instance, so its liveRunExecutions
   * set is empty — exactly the post-process-death / pre-reap window.
   */
  async function seedIssueHeldByZombie() {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue held by a zombie run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const zombieRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: zombieRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_monitor_due", responsibleUserId: RESPONSIBLE_USER_ID },
    });

    await db
      .update(issues)
      .set({
        executionRunId: zombieRunId,
        executionAgentNameKey: "cto",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    return { companyId, agentId, issueId, zombieRunId };
  }

  /**
   * Every run row created for the issue. We count rows, not live statuses: the
   * dispatched run may already have failed by the time we assert (no adapter in
   * the test host), but a run that was created and dispatched is a run that
   * started — which is exactly what the lock is supposed to prevent.
   */
  async function runsSpawnedForIssue(companyId: string, issueId: string, zombieRunId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        sql`${heartbeatRuns.companyId} = ${companyId}
          and ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      );
    return rows.filter((row) => row.id !== zombieRunId);
  }

  it("takes the lock over from the zombie on the first wake instead of leaving it stale", async () => {
    const { companyId, agentId, issueId, zombieRunId } = await seedIssueHeldByZombie();
    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(agentId, {
      source: "automation",
      contextSnapshot: { issueId, wakeReason: "issue_children_completed", responsibleUserId: RESPONSIBLE_USER_ID },
    });

    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueId));

    // The lock must no longer point at the dead run — otherwise the next wake
    // repeats the same fall-through and leaks again.
    expect(issueAfter?.executionRunId).not.toBe(zombieRunId);

    const spawned = await runsSpawnedForIssue(companyId, issueId, zombieRunId);
    expect(spawned).toHaveLength(1);
  });

  it("does not start a second run when a wake arrives 7s after the zombie takeover", async () => {
    // This is the exact production sequence: two wakes 7 seconds apart, both
    // landing while the DB still shows an older run as "running".
    const { companyId, agentId, issueId, zombieRunId } = await seedIssueHeldByZombie();
    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(agentId, {
      source: "automation",
      contextSnapshot: { issueId, wakeReason: "issue_children_completed", responsibleUserId: RESPONSIBLE_USER_ID },
    });
    await heartbeat.wakeup(agentId, {
      source: "automation",
      contextSnapshot: { issueId, wakeReason: "issue_monitor_due", responsibleUserId: RESPONSIBLE_USER_ID },
    });

    const spawned = await runsSpawnedForIssue(companyId, issueId, zombieRunId);

    // Before the fix this is 2 (and grows by one for every further wake).
    expect(spawned).toHaveLength(1);
  });

  it("does not leak a run per wake under a burst of five wakes", async () => {
    const { companyId, agentId, issueId, zombieRunId } = await seedIssueHeldByZombie();
    const heartbeat = heartbeatService(db);

    for (let i = 0; i < 5; i += 1) {
      await heartbeat.wakeup(agentId, {
        source: "automation",
        contextSnapshot: { issueId, wakeReason: "issue_monitor_due", responsibleUserId: RESPONSIBLE_USER_ID },
      });
    }

    const spawned = await runsSpawnedForIssue(companyId, issueId, zombieRunId);
    expect(spawned).toHaveLength(1);
  });
});
