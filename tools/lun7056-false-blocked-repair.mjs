#!/usr/bin/env node
/**
 * LUN-7056 — false-blocked repair CLI (acceptance criterion 5).
 *
 * Paperclip's recovery service escalates a failed run by writing status="blocked"
 * on the issue with blockedByIssueIds = the (often empty) set of existing unresolved
 * blockers, and never sets unblockDescriptor. The result is a "false-blocked" issue:
 *
 *     status = blocked   +   blockedBy = []   +   unblockDescriptor = null
 *
 * In that state no unblock event can ever fire and nothing wakes the ticket.
 *
 * This tool finds those issues and restores them through the ONLY sanctioned
 * relaunch route: POST /api/issues/{id}/recovery-actions/resolve.
 * A status PATCH is never used, in any code path.
 *
 * Request body shape (from the checked-in spec, packages/shared/src/validators/issue.ts:377
 * `resolveIssueRecoveryActionSchema`, surfaced in server/src/routes/openapi.ts:7299):
 *     { actionId?: uuid, outcome: "restored"|"false_positive"|"blocked"|"cancelled",
 *       sourceIssueStatus: "todo"|"done"|"in_review"|"blocked", resolutionNote?: string|null }
 * with outcome="restored" requiring sourceIssueStatus in {todo, done, in_review}.
 *
 * Usage: see --help.  Default mode is dry-run; writes require --apply.
 */

import { appendFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config / CLI
// ---------------------------------------------------------------------------

const USAGE = `
lun7056-false-blocked-repair — repair Paperclip "false-blocked" issues (LUN-7056 AC5)

USAGE
  node tools/lun7056-false-blocked-repair.mjs [MODE] [OPTIONS]

MODES
  --list                 (default) Classify every blocked issue. Read-only, no writes.
  --probe <IDENTIFIER>   Run the full repair on exactly ONE issue (e.g. --probe LUN-7035)
                         and print the before/after payload diff. Requires --apply to write.
  --apply                Repair every false_blocked issue, one at a time, 45s apart.
  --help                 This text.

OPTIONS
  --limit N              Cap the number of issues repaired in an --apply sweep.
  --since YYYY-MM-DD     Only sweep issues whose blockedTransitionAt is on/after this date.
                         Issues with blockedTransitionAt=null are excluded when --since is set.
  --ledger <path>        JSONL action ledger (default ./lun7056-repair-ledger.jsonl).
  --delay-ms N           Override the inter-issue wait in --apply (default 45000).
                         Lower values risk walking the fleet back into the provider quota wall.
  --json                 Emit machine-readable JSON instead of the human table (--list only).

SAFETY
  * Default mode is dry-run. Nothing is written without an explicit --apply.
  * The only write performed is POST /api/issues/{id}/recovery-actions/resolve
    with outcome="restored", sourceIssueStatus="todo". A status PATCH is never issued.
  * If an issue has no active recovery action, it is recorded as needs_manual — there is
    no fallback write path.
  * Exit code 1 if any issue ended needs_manual, else 0.

ENVIRONMENT
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID must be set.
  The API key is never printed, and never written to the ledger.
`.trim();

function parseArgs(argv) {
  const opts = {
    mode: "list",
    probe: null,
    apply: false,
    limit: null,
    since: null,
    ledger: "./lun7056-repair-ledger.jsonl",
    delayMs: 45_000,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        opts.mode = "help";
        break;
      case "--list":
        opts.mode = "list";
        break;
      case "--probe":
        opts.mode = "probe";
        opts.probe = next().toUpperCase();
        break;
      case "--apply":
        opts.apply = true;
        if (opts.mode === "list") opts.mode = "apply";
        break;
      case "--limit":
        opts.limit = Number.parseInt(next(), 10);
        if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer");
        break;
      case "--since": {
        const v = next();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("--since must be YYYY-MM-DD");
        opts.since = v;
        break;
      }
      case "--ledger":
        opts.ledger = next();
        break;
      case "--delay-ms":
        opts.delayMs = Number.parseInt(next(), 10);
        if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) throw new Error("--delay-ms must be >= 0");
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let BASE = "";
let COMPANY_ID = "";
let API_KEY = "";

/**
 * Perform an API call. Returns { status, ok, body, text }.
 * Never logs, returns or stores the Authorization header.
 */
async function api(method, path, body) {
  const url = `${BASE}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { status: 0, ok: false, body: null, text: `network error: ${err?.message ?? String(err)}` };
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

async function apiJsonOrThrow(method, path, body) {
  const res = await api(method, path, body);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${summarizeResponse(res).slice(0, 300)}`);
  }
  return res.body;
}

function summarizeResponse(res) {
  if (res.body && typeof res.body === "object") {
    const b = res.body;
    const parts = [];
    if (b.error) parts.push(`error=${typeof b.error === "string" ? b.error : JSON.stringify(b.error)}`);
    if (b.message) parts.push(`message=${b.message}`);
    if (b.code) parts.push(`code=${b.code}`);
    if (b.issue?.status) parts.push(`issue.status=${b.issue.status}`);
    if (b.recoveryAction?.status) parts.push(`recoveryAction.status=${b.recoveryAction.status}`);
    if (b.recoveryAction?.outcome) parts.push(`recoveryAction.outcome=${b.recoveryAction.outcome}`);
    if (parts.length > 0) return parts.join(" ");
    return JSON.stringify(b).slice(0, 400);
  }
  return (res.text ?? "").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function listBlockedIssues() {
  const data = await apiJsonOrThrow(
    "GET",
    `/api/companies/${COMPANY_ID}/issues?status=blocked&limit=200`,
  );
  // This endpoint returns a bare JSON array, not an envelope. Tolerate both.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.issues)) return data.issues;
  throw new Error("Unexpected shape from the blocked-issue list endpoint");
}

async function loadAgentNames() {
  const map = new Map();
  try {
    const data = await apiJsonOrThrow("GET", `/api/companies/${COMPANY_ID}/agents`);
    const arr = Array.isArray(data) ? data : (data?.items ?? data?.agents ?? []);
    for (const a of arr) if (a?.id) map.set(a.id, a.name ?? a.title ?? a.id);
  } catch {
    // Agent names are cosmetic; fall back to raw ids.
  }
  return map;
}

const issueCache = new Map();
async function getIssueDetail(id) {
  if (issueCache.has(id)) return issueCache.get(id);
  const detail = await apiJsonOrThrow("GET", `/api/issues/${id}`);
  issueCache.set(id, detail);
  return detail;
}

/** live-runs is the ONLY truthful source of whether an issue has a live run. */
async function getLiveRuns(id) {
  const res = await api("GET", `/api/issues/${id}/live-runs`);
  if (!res.ok) return { count: null, runs: [], error: `HTTP ${res.status}` };
  const arr = Array.isArray(res.body) ? res.body : (res.body?.items ?? res.body?.runs ?? []);
  return { count: arr.length, runs: arr, error: null };
}

async function getPendingInteractions(id) {
  const res = await api("GET", `/api/issues/${id}/interactions`);
  if (!res.ok) return { pending: [], error: `HTTP ${res.status}` };
  const arr = Array.isArray(res.body) ? res.body : (res.body?.items ?? []);
  return { pending: arr.filter((i) => i?.status === "pending"), error: null };
}

async function getPendingApprovals(id) {
  const res = await api("GET", `/api/issues/${id}/approvals`);
  if (!res.ok) return { pending: [], error: `HTTP ${res.status}` };
  const arr = Array.isArray(res.body) ? res.body : (res.body?.items ?? []);
  return {
    pending: arr.filter((a) => a?.status === "pending" || a?.status === "revision_requested"),
    error: null,
  };
}

async function getActiveRecoveryAction(id) {
  const res = await api("GET", `/api/issues/${id}/recovery-actions`);
  if (!res.ok) return { active: null, error: `HTTP ${res.status}: ${summarizeResponse(res)}` };
  const active = res.body?.active ?? (Array.isArray(res.body?.actions) ? res.body.actions[0] : null) ?? null;
  return { active, error: null };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const RESOLVED_BLOCKER_STATUSES = new Set(["done"]);

/**
 * Collect blocker candidates. `blockedBy` on the detail payload is the primary
 * source, but blockerAttention can name a direct/terminal blocker that does not
 * appear in blockedBy (observed on LUN-6516 -> LUN-6621), so we take both.
 * We never trust blockerAttention.unresolvedBlockerCount: it counts `done`
 * blockers as unresolved. We read each blocker's own status instead.
 */
async function collectUnresolvedBlockers(detail) {
  const candidateIds = new Set();
  const known = new Map();
  for (const b of Array.isArray(detail.blockedBy) ? detail.blockedBy : []) {
    if (!b?.id) continue;
    candidateIds.add(b.id);
    known.set(b.id, b);
  }
  const att = detail.blockerAttention;
  if (att?.directBlockerIssueId) candidateIds.add(att.directBlockerIssueId);
  if (att?.terminalBlockerIssueId && att.terminalBlockerIssueId !== detail.id) {
    candidateIds.add(att.terminalBlockerIssueId);
  }
  candidateIds.delete(detail.id);

  const unresolved = [];
  for (const id of candidateIds) {
    let summary = known.get(id);
    if (!summary?.status) {
      try {
        const full = await getIssueDetail(id);
        summary = { id, identifier: full.identifier, status: full.status, title: full.title };
      } catch {
        // Unreadable blocker: treat as unresolved (conservative — never relaunch).
        summary = { id, identifier: id, status: "unknown", title: "" };
      }
    }
    if (!RESOLVED_BLOCKER_STATUSES.has(summary.status)) {
      unresolved.push(summary);
    }
  }
  return unresolved;
}

/**
 * Classify a single blocked issue. Read-only.
 * Returns { id, identifier, ..., classification, reason }.
 */
async function classifyIssue(listRow) {
  const detail = await getIssueDetail(listRow.id);
  const [liveRuns, interactions, approvals] = await Promise.all([
    getLiveRuns(detail.id),
    getPendingInteractions(detail.id),
    getPendingApprovals(detail.id),
  ]);

  const base = {
    id: detail.id,
    identifier: detail.identifier ?? detail.id,
    title: detail.title ?? "",
    status: detail.status,
    unblockDescriptor: detail.unblockDescriptor ?? null,
    blockedBy: Array.isArray(detail.blockedBy) ? detail.blockedBy.map((b) => b.identifier ?? b.id) : [],
    blockedTransitionAt: detail.blockedTransitionAt ?? null,
    monitorNextCheckAt: detail.monitorNextCheckAt ?? null,
    assigneeAgentId: detail.assigneeAgentId ?? null,
    liveRunCount: liveRuns.count,
    hasActiveRecoveryAction: Boolean(detail.activeRecoveryAction),
  };

  // Idempotency: anything no longer blocked has already been restored.
  if (detail.status !== "blocked") {
    return { ...base, classification: "already_restored", reason: `status=${detail.status}` };
  }

  if (detail.unblockDescriptor != null) {
    return { ...base, classification: "legitimately_blocked", reason: "has_unblock_descriptor" };
  }
  if (interactions.pending.length > 0) {
    return {
      ...base,
      classification: "legitimately_blocked",
      reason: `pending_interaction(${interactions.pending.length})`,
    };
  }
  if (approvals.pending.length > 0) {
    return {
      ...base,
      classification: "legitimately_blocked",
      reason: `pending_approval(${approvals.pending.length})`,
    };
  }

  const unresolved = await collectUnresolvedBlockers(detail);
  if (unresolved.length > 0) {
    const sample = unresolved[0].identifier ?? unresolved[0].id;
    return {
      ...base,
      classification: "legitimately_blocked",
      reason: `unresolved_blocker(${unresolved.length}) e.g. ${sample}[${unresolved[0].status}]`,
      unresolvedBlockers: unresolved.map((b) => `${b.identifier ?? b.id}[${b.status}]`),
    };
  }

  if (detail.blockerAttention?.blockingTreeLive === true) {
    return { ...base, classification: "legitimately_blocked", reason: "blocking_tree_live" };
  }

  return {
    ...base,
    classification: "false_blocked",
    reason: "blocked + no blockers + no descriptor + no pending interaction/approval",
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

let ledgerPath = "./lun7056-repair-ledger.jsonl";

async function ledger(entry) {
  const record = {
    ts: new Date().toISOString(),
    tool: "lun7056-false-blocked-repair",
    ...entry,
  };
  // Defence in depth: no header/secret material ever reaches the ledger.
  delete record.headers;
  delete record.authorization;
  delete record.apiKey;
  try {
    await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error(`! ledger write failed (${err?.message ?? err})`);
  }
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

const RESOLUTION_NOTE =
  "LUN-7056 false-blocked repair: issue was status=blocked with no blockers, no unblockDescriptor " +
  "and no pending interaction, so no unblock event could ever fire. Restored to todo via the " +
  "recovery-action resolve route.";

/**
 * Repair one issue. Writes ONLY when apply=true.
 * Never falls back to a status PATCH.
 */
async function repairIssue(row, { apply }) {
  const { active, error } = await getActiveRecoveryAction(row.id);

  if (error) {
    await ledger({
      identifier: row.identifier, id: row.id, classification: row.classification,
      action: "get_recovery_actions", httpStatus: null, result: "needs_manual", summary: error,
    });
    return { outcome: "needs_manual", why: `could not read recovery actions: ${error}` };
  }

  if (!active) {
    const why =
      "no active recovery action on the issue — recovery-actions/resolve would 404 " +
      "(\"Active recovery action not found\"), and a status PATCH is not a sanctioned relaunch route";
    await ledger({
      identifier: row.identifier, id: row.id, classification: row.classification,
      action: "resolve_precheck", httpStatus: null, result: "needs_manual", summary: why,
    });
    return { outcome: "needs_manual", why };
  }

  const payload = {
    actionId: active.id,
    outcome: "restored",
    sourceIssueStatus: "todo",
    resolutionNote: RESOLUTION_NOTE,
  };

  if (!apply) {
    await ledger({
      identifier: row.identifier, id: row.id, classification: row.classification,
      action: "resolve", httpStatus: null, result: "dry_run",
      summary: `would POST /api/issues/${row.id}/recovery-actions/resolve`,
      requestBody: payload,
    });
    return { outcome: "dry_run", why: `would resolve recovery action ${active.id} (kind=${active.kind ?? "?"})`, payload };
  }

  const res = await api("POST", `/api/issues/${row.id}/recovery-actions/resolve`, payload);
  const summary = summarizeResponse(res);
  await ledger({
    identifier: row.identifier, id: row.id, classification: row.classification,
    action: "resolve", httpStatus: res.status, result: res.ok ? "restored" : "needs_manual",
    summary, requestBody: payload,
  });
  if (!res.ok) {
    return { outcome: "needs_manual", why: `HTTP ${res.status}: ${summary}`, payload };
  }
  return {
    outcome: "restored",
    why: summary,
    payload,
    newStatus: res.body?.issue?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function truncate(s, n) {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length <= n ? v : `${v.slice(0, n - 1)}…`;
}

function fmtTs(v) {
  if (!v) return "—";
  return String(v).replace(".000Z", "Z").replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
}

function renderTable(rows, agentNames) {
  const header = ["IDENTIFIER", "BLOCKED_TRANSITION_AT", "ASSIGNEE", "MONITOR_NEXT_CHECK_AT", "LIVE", "CLASSIFICATION", "TITLE"];
  const body = rows.map((r) => [
    r.identifier,
    fmtTs(r.blockedTransitionAt),
    truncate(r.assigneeAgentId ? (agentNames.get(r.assigneeAgentId) ?? r.assigneeAgentId) : "—", 22),
    fmtTs(r.monitorNextCheckAt),
    r.liveRunCount === null ? "?" : String(r.liveRunCount),
    r.classification,
    truncate(r.title, 50),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(line(b));
}

function renderSummary(rows) {
  const byClass = new Map();
  for (const r of rows) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);
  console.log("");
  console.log("SUMMARY BY CLASSIFICATION");
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}`);
  }
  console.log(`  ${"TOTAL".padEnd(24)} ${String(rows.length).padStart(4)}`);

  const falseBlocked = rows.filter((r) => r.classification === "false_blocked");
  const dateBucket = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = r.blockedTransitionAt ? String(r.blockedTransitionAt).slice(0, 10) : "(null)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  };

  console.log("");
  console.log("ALL BLOCKED, BY blockedTransitionAt DATE");
  for (const [k, v] of dateBucket(rows)) console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}`);
  console.log("");
  console.log("FALSE_BLOCKED ONLY, BY blockedTransitionAt DATE");
  for (const [k, v] of dateBucket(falseBlocked)) console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}`);

  const withLive = falseBlocked.filter((r) => (r.liveRunCount ?? 0) > 0);
  const withAction = falseBlocked.filter((r) => r.hasActiveRecoveryAction);
  console.log("");
  console.log(`false_blocked with a live run (repair would be skipped): ${withLive.length}`);
  console.log(`false_blocked with an active recovery action (repairable): ${withAction.length}`);
  console.log(`false_blocked with NO active recovery action (needs_manual): ${falseBlocked.length - withAction.length}`);
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

function applyScope(rows, opts) {
  let out = rows;
  if (opts.since) {
    out = out.filter((r) => r.blockedTransitionAt && String(r.blockedTransitionAt).slice(0, 10) >= opts.since);
  }
  out = [...out].sort((a, b) => String(b.blockedTransitionAt ?? "").localeCompare(String(a.blockedTransitionAt ?? "")));
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function modeList(opts) {
  const [blocked, agentNames] = await Promise.all([listBlockedIssues(), loadAgentNames()]);
  console.error(`# fetched ${blocked.length} blocked issues; reading details…`);
  const rows = await mapWithConcurrency(blocked, 4, (row) => classifyIssue(row));
  const scoped = applyScope(rows, opts);

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), count: scoped.length, rows: scoped }, null, 2));
    return 0;
  }
  renderTable(scoped, agentNames);
  renderSummary(scoped);
  console.log("");
  console.log("Dry-run classification only. No writes performed. Use --probe <ID> then --apply.");
  return 0;
}

function snapshot(detail, liveRunCount) {
  return {
    status: detail.status,
    unblockDescriptor: detail.unblockDescriptor ?? null,
    blockedBy: Array.isArray(detail.blockedBy) ? detail.blockedBy.map((b) => b.identifier ?? b.id) : [],
    monitorNextCheckAt: detail.monitorNextCheckAt ?? null,
    activeRecoveryActionId: detail.activeRecoveryAction?.id ?? null,
    liveRunCount,
  };
}

function printDiff(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  console.log("");
  console.log("BEFORE / AFTER");
  console.log(`  ${"FIELD".padEnd(24)} ${"BEFORE".padEnd(34)} AFTER`);
  for (const k of keys) {
    const b = JSON.stringify(before[k]);
    const a = JSON.stringify(after[k]);
    const mark = b === a ? "   " : " * ";
    console.log(`${mark}${k.padEnd(24)} ${String(b).padEnd(34)} ${a}`);
  }
}

async function modeProbe(opts) {
  const blocked = await listBlockedIssues();
  const match = blocked.find((r) => (r.identifier ?? "").toUpperCase() === opts.probe);
  if (!match) {
    console.error(`Issue ${opts.probe} is not in the blocked list. Nothing to probe.`);
    console.error("(If it was already repaired, that is the expected idempotent outcome.)");
    return 0;
  }
  const row = await classifyIssue(match);
  console.log(`${row.identifier}  ${truncate(row.title, 70)}`);
  console.log(`  classification : ${row.classification}`);
  console.log(`  reason         : ${row.reason}`);
  console.log(`  live runs      : ${row.liveRunCount}`);

  const beforeDetail = await getIssueDetail(row.id);
  const before = snapshot(beforeDetail, row.liveRunCount);

  if (row.classification !== "false_blocked") {
    console.log("");
    console.log(`Not false_blocked — no repair attempted (${row.classification}).`);
    await ledger({
      identifier: row.identifier, id: row.id, classification: row.classification,
      action: "probe_skip", httpStatus: null, result: "skipped", summary: row.reason,
    });
    return 0;
  }

  if ((row.liveRunCount ?? 0) > 0) {
    console.log("");
    console.log(`Skipped: issue already has ${row.liveRunCount} live run(s) — it has a live path.`);
    await ledger({
      identifier: row.identifier, id: row.id, classification: row.classification,
      action: "probe_skip", httpStatus: null, result: "skipped",
      summary: `has_live_run(${row.liveRunCount})`,
    });
    return 0;
  }

  console.log("");
  console.log(opts.apply ? "Applying repair…" : "DRY RUN — pass --apply to actually write.");
  const result = await repairIssue(row, { apply: opts.apply });
  console.log(`  outcome: ${result.outcome} — ${result.why}`);
  if (result.payload) console.log(`  request body: ${JSON.stringify(result.payload)}`);

  issueCache.delete(row.id);
  const afterDetail = await getIssueDetail(row.id);
  const afterLive = await getLiveRuns(row.id);
  printDiff(before, snapshot(afterDetail, afterLive.count));

  return result.outcome === "needs_manual" ? 1 : 0;
}

async function modeApply(opts) {
  const [blocked, agentNames] = await Promise.all([listBlockedIssues(), loadAgentNames()]);
  console.log(`# ${blocked.length} blocked issues; classifying…`);
  const rows = await mapWithConcurrency(blocked, 4, (row) => classifyIssue(row));
  const candidates = applyScope(rows.filter((r) => r.classification === "false_blocked"), opts);

  console.log(`# ${candidates.length} false_blocked issue(s) in scope` +
    `${opts.since ? ` (since ${opts.since})` : ""}${opts.limit ? ` (limit ${opts.limit})` : ""}`);
  if (!opts.apply) {
    console.log("# DRY RUN — no writes. Pass --apply to repair.");
  }
  console.log(`# pacing: ${opts.delayMs}ms between issues`);
  console.log("");

  const tally = { restored: 0, needs_manual: 0, skipped: 0, dry_run: 0 };
  const manual = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    const label = `[${i + 1}/${candidates.length}] ${row.identifier}`;
    const who = row.assigneeAgentId ? (agentNames.get(row.assigneeAgentId) ?? row.assigneeAgentId) : "unassigned";

    // Re-read immediately before writing: another run may have repaired it.
    issueCache.delete(row.id);
    const fresh = await classifyIssue({ id: row.id });
    if (fresh.classification !== "false_blocked") {
      tally.skipped += 1;
      console.log(`${label}  SKIP (${fresh.classification}: ${fresh.reason})`);
      await ledger({
        identifier: row.identifier, id: row.id, classification: fresh.classification,
        action: "skip", httpStatus: null, result: "skipped", summary: fresh.reason,
      });
      continue;
    }
    if ((fresh.liveRunCount ?? 0) > 0) {
      tally.skipped += 1;
      console.log(`${label}  SKIP (has ${fresh.liveRunCount} live run(s) — already on a live path)`);
      await ledger({
        identifier: row.identifier, id: row.id, classification: fresh.classification,
        action: "skip", httpStatus: null, result: "skipped", summary: `has_live_run(${fresh.liveRunCount})`,
      });
      continue;
    }

    console.log(`${label}  ${truncate(fresh.title, 50)}  [${who}]`);
    const result = await repairIssue(fresh, { apply: opts.apply });
    tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
    console.log(`${" ".repeat(label.length)}  -> ${result.outcome}: ${result.why}`);
    if (result.outcome === "needs_manual") manual.push({ identifier: row.identifier, why: result.why });

    if (i < candidates.length - 1 && opts.delayMs > 0) {
      console.log(`${" ".repeat(label.length)}  … waiting ${Math.round(opts.delayMs / 1000)}s before the next issue`);
      await sleep(opts.delayMs);
    }
  }

  console.log("");
  console.log("SWEEP RESULT");
  for (const [k, v] of Object.entries(tally)) if (v) console.log(`  ${k.padEnd(14)} ${v}`);
  if (manual.length > 0) {
    console.log("");
    console.log("NEEDS MANUAL ATTENTION (no write was attempted or the write was refused):");
    for (const m of manual) console.log(`  ${m.identifier}: ${m.why}`);
  }
  console.log("");
  console.log(`Ledger: ${ledgerPath}`);
  return manual.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    console.error(USAGE);
    return 2;
  }
  if (opts.mode === "help") {
    console.log(USAGE);
    return 0;
  }

  const rawUrl = requireEnv("PAPERCLIP_API_URL");
  BASE = rawUrl.replace(/\/$/, "").replace(/\/api$/, "");
  API_KEY = requireEnv("PAPERCLIP_API_KEY");
  COMPANY_ID = requireEnv("PAPERCLIP_COMPANY_ID");
  ledgerPath = opts.ledger;

  if (opts.mode === "list") return modeList(opts);
  if (opts.mode === "probe") return modeProbe(opts);
  return modeApply(opts);
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    // Redaction guard: never let a key leak through an error message.
    const msg = String(err?.stack ?? err?.message ?? err);
    console.error(`Fatal: ${API_KEY ? msg.split(API_KEY).join("[REDACTED]") : msg}`);
    process.exitCode = 2;
  });
