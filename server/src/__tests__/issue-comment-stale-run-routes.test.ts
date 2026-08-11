// LUN-5207 regression: POST /api/issues/:id/comments had no run-ownership
// guard, so a run the orchestrator already marked terminal (cancelled/failed/
// ...) could keep posting comments while a live successor run held the issue
// checkout. The zombie's comments read as the issue's current voice and each
// one queued an extra heartbeat wake (LUN-4107).
//
// The fix does not reject the write — a close-out comment is a run's main
// liveness path — it accepts it but strips its authority: quiet
// `system_notice` presentation, no reopen/resume steering, no wake. This file
// exercises the real `isStaleRunIssueComment` predicate through the route by
// staging run rows on `heartbeat.getRun` — nothing about the verdict is
// stubbed — to prove the authority-stripping happens end to end, and that a
// *legitimate* (non-stale) close-out keeps its full authority.
//
// Harness copied from issue-comment-reopen-routes.test.ts.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  orderBy: mockDbSelectOrderBy,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceLimitError = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceRunContextError = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", () => ({
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
  crossIssueInfluenceLimitError: mockCrossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError: mockCrossIssueInfluenceRunContextError,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const AUTHOR_RUN_ID = "33333333-3333-4333-8333-333333333333";
const SUCCESSOR_RUN_ID = "66666666-6666-4666-8666-666666666666";

/**
 * Stage the two run rows the route reads. `authorStatus` terminal +
 * `checkoutStatus` live is the zombie case; anything else must leave the
 * comment fully authoritative.
 */
function stageRuns(authorStatus: string, checkoutStatus: string) {
  mockHeartbeatService.getRun.mockImplementation(async (runId: string) => {
    if (runId === AUTHOR_RUN_ID) return { id: runId, status: authorStatus };
    if (runId === SUCCESSOR_RUN_ID) return { id: runId, status: checkoutStatus };
    return null;
  });
}

const stageZombieAuthor = () => stageRuns("cancelled", "running");
const stageLiveAuthor = () => stageRuns("running", "running");

function makeIssue(status: "backlog" | "todo" | "done" | "blocked" | "cancelled" | "in_progress" | "in_review") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Stale run comment guard",
    // The successor run holds both locks — the exact shape measured on
    // LUN-4488: the checkout was handed over 15 ms after the author run was
    // cancelled, and the author's process kept writing for another 66 s.
    checkoutRunId: SUCCESSOR_RUN_ID,
    executionRunId: SUCCESSOR_RUN_ID,
  };
}

// The review participant is the same agent the peer actor authenticates as, so the
// auto-approval gate's id match succeeds and `!staleRunComment` is provably the only
// thing separating the two cases below.
const REVIEW_PARTICIPANT_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_APPROVAL_BODY = "## Review: PAP-580 - APPROVED\n\nLooks good.";
const REVIEW_STAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function makeReviewStageIssue() {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      {
        id: REVIEW_STAGE_ID,
        type: "review",
        participants: [{ type: "agent", agentId: REVIEW_PARTICIPANT_AGENT_ID }],
      },
    ],
  });
  return {
    ...makeIssue("in_review"),
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: REVIEW_STAGE_ID,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: REVIEW_PARTICIPANT_AGENT_ID },
      returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
  };
}

// Peer (non-assignee) agent actor. Used instead of the assignee so that the
// pre-existing "self-comment" wake skip can't be confused with the
// staleRunComment guard under test — with a peer actor, the assignee wake
// and @-mention wake would fire if staleRunComment did not suppress them.
function peerAgentActor(agentId = "44444444-4444-4444-8444-444444444444") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: AUTHOR_RUN_ID,
  };
}

function assigneeAgentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: AUTHOR_RUN_ID,
  };
}

/**
 * The comment wake block is fire-and-forget, so a bare `not.toHaveBeenCalled()`
 * straight after the 201 would pass even if the wake were merely late. Drain
 * the queue first; each negative case below is also paired with a positive
 * counterpart proving the same request shape DOES wake when the author run is
 * live.
 */
async function drainWakeups() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue comment stale-run routes (LUN-5207)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockExternalObjectService.syncCommentSafely.mockReset();
    mockExternalObjectService.syncIssueSafely.mockReset();
    mockObserveCrossIssueInfluence.mockReset();
    mockCrossIssueInfluenceLimitError.mockReset();
    mockCrossIssueInfluenceRunContextError.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
    mockExternalObjectService.syncIssueSafely.mockResolvedValue(undefined);
    mockObserveCrossIssueInfluence.mockResolvedValue({
      allowed: true,
      mode: "log_only",
      count: 1,
      cap: 20,
      enforceAt: "2026-08-11T00:00:00.000Z",
    });
    mockCrossIssueInfluenceLimitError.mockImplementation((decision: { count: number; cap: number }) => ({
      error: `Cross-issue influence cap exceeded: this run is limited to ${decision.cap} cross-issue comments or updates`,
      details: { code: "cross_issue_influence_cap_exceeded", count: decision.count, cap: decision.cap },
    }));
    mockCrossIssueInfluenceRunContextError.mockImplementation(() => new HttpError(
      403,
      "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
      { code: "cross_issue_influence_run_context_required" },
    ));
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "44444444-4444-4444-8444-444444444444",
      authorUserId: null,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    // Peer agent comments/mutations are allowed by default so a stale-run
    // suppression is provably the guard doing the work, not an access denial.
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = input.action !== "tasks:manage_active_checkouts";
      return {
        allowed,
        action: input.action,
        reason: allowed
          ? (input.action === "issue:comment" || input.action === "issue:mutate"
            ? "allow_visible_issue_write"
            : "allow_explicit_grant")
          : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : "Missing active checkout override.",
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
  });

  // Case 1: a zombie run's plain close-out comment is still written, but
  // demoted — quiet system_notice, no wake. Presentation is asserted against
  // the actual STALE_RUN_COMMENT_PRESENTATION field values (not just a truthy
  // check) so a change to that constant's shape breaks this test loudly.
  it("accepts a stale-run comment but demotes its presentation and skips the wake", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageZombieAuthor();

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Final status from a run that already ended." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Final status from a run that already ended.",
      expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444" }),
      expect.objectContaining({
        presentation: {
          kind: "system_notice",
          tone: "warning",
          title: "Stale run — this comment is not the current voice of the issue",
          detailsDefaultOpen: false,
          density: "compact",
        },
      }),
    );
    await drainWakeups();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // Case 2: a stale run's reopen: true must not steer the issue. Compare
  // against the "not stale" counterpart below, which sends the identical
  // request and DOES reopen — proving staleRunComment, not some other guard,
  // is what suppresses this one.
  it("does not reopen a closed issue via a stale-run comment even with reopen: true", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    stageZombieAuthor();

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Zombie asking for reopen.", reopen: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
    await drainWakeups();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still reopens a closed issue via reopen: true when the comment is not from a stale run", async () => {
    const issue = makeIssue("done");
    mockIssueService.getById.mockResolvedValue(issue);
    stageLiveAuthor();
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Legitimate reopen request.", reopen: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    ));
  });

  // Case 3: an @-mention from a zombie run must not wake the mentioned agent
  // either — same "no authority" rule as the assignee wake above. Seed
  // findMentionedAgents to resolve a real id: if the guard failed to skip the
  // call, the mention would produce a wake and the assertion below would
  // catch it.
  it("does not resolve or wake @-mentions from a stale-run comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageZombieAuthor();
    mockIssueService.findMentionedAgents.mockResolvedValue(["55555555-5555-4555-8555-555555555555"]);

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@someone please look at this." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
    await drainWakeups();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still resolves and wakes @-mentions when the comment is not from a stale run", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageLiveAuthor();
    mockIssueService.findMentionedAgents.mockResolvedValue(["55555555-5555-4555-8555-555555555555"]);

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@someone please look at this." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith("company-1", "@someone please look at this.");
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    ));
  });

  // Case 4 (the important regression guard): a legitimate close-out comment
  // — the same run that holds the checkout, or one the resolver otherwise
  // does not flag as stale — must keep full authority. Presentation is
  // exactly what deriveRecoveryCommentPresentation would have produced (null
  // for a plain work update), not the stale system_notice shape, and the
  // ordinary assignee wake still fires because this actor is not the
  // assignee (peer comment => issue_commented, not self-comment skipped).
  it("leaves a non-stale comment's presentation and assignee wake untouched", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageLiveAuthor();

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Normal work update." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Normal work update.",
      expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444" }),
      expect.objectContaining({ presentation: null }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_commented" }),
    ));
  });

  // Sanity check that the same-run case (author holds the checkout itself)
  // never gets flagged stale, matching isStaleRunIssueComment's "no successor
  // holds the lock" early return. This exercises the assignee-authored path
  // (self-comment) to show the guard composes correctly with the pre-existing
  // self-comment wake skip rather than masking it.
  it("does not demote the assignee's own comment when its author run is live", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageLiveAuthor();

    const res = await request(await installActor(createApp(), assigneeAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Working on it." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Working on it.",
      expect.objectContaining({ agentId: "22222222-2222-4222-8222-222222222222" }),
      expect.objectContaining({ presentation: null }),
    );
    await drainWakeups();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // Fail-open guard 1: the author run is terminal but the checkout holder is
  // terminal too — the lock is merely stale, nobody else is speaking for the
  // issue, and demoting this close-out would silence the thread entirely.
  it("keeps a terminal run's close-out authoritative when the checkout holder is also terminal", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    stageRuns("cancelled", "failed");

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Close-out after the successor died too." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Close-out after the successor died too.",
      expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444" }),
      expect.objectContaining({ presentation: null }),
    );
  });

  // Fail-open guard 2: a run row that no longer exists must not be guessed at.
  it("keeps the comment authoritative when the author run row is missing", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Close-out with no run row." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Close-out with no run row.",
      expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444" }),
      expect.objectContaining({ presentation: null }),
    );
  });

  // Review-stage auto-approval (Otto, review of PR #2). `shouldAutoApproveReviewComment`
  // matches on agent/user id only — `actorMatchesExecutionParticipant` never looks at runId —
  // so without the `!staleRunComment` gate a zombie run of the review participant could still
  // drive in_review -> done from a comment that renders as a muted system notice. Worse than
  // the original bug: quiet bubble, real status change. Paired with the live-author counterpart
  // below sending the identical request, which DOES approve.
  it("does not auto-approve a review stage from a stale-run APPROVED comment", async () => {
    const issue = await makeReviewStageIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    stageZombieAuthor();
    // Stage the same successful update the live-author case uses, so removing the
    // `!staleRunComment` gate fails this test on `update` being called — not on a
    // downstream 404 from an unmocked update inside the auto-approval transaction.
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      status: "done",
    }));

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: REVIEW_APPROVAL_BODY });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      REVIEW_APPROVAL_BODY,
      expect.objectContaining({ agentId: REVIEW_PARTICIPANT_AGENT_ID }),
      expect.objectContaining({
        presentation: expect.objectContaining({ kind: "system_notice", tone: "warning" }),
      }),
    );
    await drainWakeups();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still auto-approves a review stage when the approving run is live", async () => {
    const issue = await makeReviewStageIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    stageLiveAuthor();
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      status: "done",
    }));

    const res = await request(await installActor(createApp(), peerAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: REVIEW_APPROVAL_BODY });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "done",
        executionState: expect.objectContaining({ lastDecisionOutcome: "approved" }),
      }),
      mockTx,
    );
  });
});
