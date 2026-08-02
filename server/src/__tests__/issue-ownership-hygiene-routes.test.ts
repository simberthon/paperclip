import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue ownership hygiene tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue ownership hygiene", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-ownership-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    // A queued wake is picked up by a real in-process run, which writes rows
    // back while we tear down. Cascading truncate is the only ordering-proof
    // reset here; every fixture uses fresh UUIDs so nothing leaks between tests.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, userId = "cloud-user-1") {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    };
  }

  /**
   * The activity log FKs `run_id` to `heartbeat_runs`, so an agent actor needs
   * a real run row or every create 500s inside the audit write.
   */
  async function agentActor(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { type: "agent", agentId, companyId, source: "agent_key", runId };
  }

  async function seedCompany(companyId: string, userId = "cloud-user-1") {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedAgent(companyId: string, agentId: string, name = "Engineer") {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  describe("no issue is created without an owner", () => {
    it("falls back to the creating agent when no assignee is given", async () => {
      const companyId = randomUUID();
      const creatorAgentId = randomUUID();
      await seedCompany(companyId);
      await seedAgent(companyId, creatorAgentId, "Creator");

      const res = await request(createApp(await agentActor(companyId, creatorAgentId)))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Orphan-prone task" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBe(creatorAgentId);
    });

    it("falls back to the creating board user when no assignee is given", async () => {
      const companyId = randomUUID();
      await seedCompany(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Task typed on the board" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBeNull();
      expect(res.body.assigneeUserId).toBe("cloud-user-1");
    });

    it("never overrides an explicit assignee", async () => {
      const companyId = randomUUID();
      const creatorAgentId = randomUUID();
      const targetAgentId = randomUUID();
      await seedCompany(companyId);
      await seedAgent(companyId, creatorAgentId, "Creator");
      await seedAgent(companyId, targetAgentId, "Target");

      const res = await request(createApp(await agentActor(companyId, creatorAgentId)))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Delegated task", assigneeAgentId: targetAgentId });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBe(targetAgentId);

      // Positive control for the suppression below: a real delegation still
      // wakes the agent being delegated to.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, targetAgentId));
      expect(wakeups).toHaveLength(1);
    });

    it("gives child issues an owner too", async () => {
      const companyId = randomUUID();
      const creatorAgentId = randomUUID();
      const parentId = randomUUID();
      await seedCompany(companyId);
      await seedAgent(companyId, creatorAgentId, "Creator");
      await db.insert(issues).values({
        id: parentId,
        companyId,
        title: "Parent",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: creatorAgentId,
      });

      const res = await request(createApp(await agentActor(companyId, creatorAgentId)))
        .post(`/api/issues/${parentId}/children`)
        .send({ title: "Child task" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBe(creatorAgentId);
    });

    it("does not wake the creator for an issue it was defaulted to own", async () => {
      const companyId = randomUUID();
      const creatorAgentId = randomUUID();
      await seedCompany(companyId);
      await seedAgent(companyId, creatorAgentId, "Creator");

      // `todo` is the status the caller would have to ask for explicitly; it is
      // the case where the wake would otherwise fire (backlog never wakes).
      const actor = await agentActor(companyId, creatorAgentId);
      const res = await request(createApp(actor))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Self-owned task", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.assigneeAgentId).toBe(creatorAgentId);

      // Give the fire-and-forget wake a chance to land before asserting absence.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, creatorAgentId));
      expect(wakeups).toHaveLength(0);
    });
  });

  describe("orphanedByClosedParent filter", () => {
    async function seedOrphanFixture(companyId: string) {
      const doneParentId = randomUUID();
      const cancelledParentId = randomUUID();
      const openParentId = randomUUID();
      const orphanOfDoneId = randomUUID();
      const orphanOfCancelledId = randomUUID();
      const healthyChildId = randomUUID();
      const rootId = randomUUID();
      const closedOrphanId = randomUUID();

      await db.insert(issues).values([
        { id: doneParentId, companyId, title: "Done parent", status: "done", priority: "medium" },
        { id: cancelledParentId, companyId, title: "Cancelled parent", status: "cancelled", priority: "medium" },
        { id: openParentId, companyId, title: "Open parent", status: "in_progress", priority: "medium" },
        { id: orphanOfDoneId, companyId, parentId: doneParentId, title: "Orphan of done", status: "todo", priority: "medium" },
        { id: orphanOfCancelledId, companyId, parentId: cancelledParentId, title: "Orphan of cancelled", status: "blocked", priority: "medium" },
        { id: healthyChildId, companyId, parentId: openParentId, title: "Healthy child", status: "todo", priority: "medium" },
        { id: rootId, companyId, title: "Root task", status: "todo", priority: "medium" },
        { id: closedOrphanId, companyId, parentId: doneParentId, title: "Closed orphan", status: "done", priority: "medium" },
      ]);

      return { orphanOfDoneId, orphanOfCancelledId, healthyChildId, rootId, closedOrphanId };
    }

    it("returns only open children whose parent is done or cancelled", async () => {
      const companyId = randomUUID();
      await seedCompany(companyId);
      const fixture = await seedOrphanFixture(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .get(`/api/companies/${companyId}/issues`)
        .query({
          orphanedByClosedParent: "true",
          status: "backlog,todo,in_progress,in_review,blocked",
          limit: "50",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((issue) => issue.id).sort();
      expect(ids).toEqual([fixture.orphanOfDoneId, fixture.orphanOfCancelledId].sort());
      // A root task has no parent, a child of an open parent is still visible in
      // the tree, and a closed orphan is not outstanding work.
      expect(ids).not.toContain(fixture.rootId);
      expect(ids).not.toContain(fixture.healthyChildId);
      expect(ids).not.toContain(fixture.closedOrphanId);
    });

    it("is inert when not requested", async () => {
      const companyId = randomUUID();
      await seedCompany(companyId);
      await seedOrphanFixture(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .get(`/api/companies/${companyId}/issues`)
        .query({ limit: "50" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.length).toBe(8);
    });

    it("rejects a non-boolean value", async () => {
      const companyId = randomUUID();
      await seedCompany(companyId);

      const res = await request(createApp(boardActor(companyId)))
        .get(`/api/companies/${companyId}/issues`)
        .query({ orphanedByClosedParent: "maybe" });

      expect(res.status).toBe(400);
    });
  });
});
