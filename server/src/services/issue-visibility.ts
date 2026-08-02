import { and, isNull, sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

/**
 * Matches issues whose parent is already `done` or `cancelled`.
 *
 * These are the board's blind spot: the tree collapses around a closed parent,
 * so live children stop being reachable by anyone browsing the hierarchy, while
 * still being perfectly real open work. Pair with a status filter to get the
 * set that actually matters — open children under a closed parent.
 */
export function orphanedByClosedParentCondition(): SQL {
  return sql`${issues.parentId} is not null and exists (
    select 1 from ${issues} as parent_issue
    where parent_issue.id = ${issues.parentId}
      and parent_issue.status in ('done', 'cancelled')
  )`;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}
