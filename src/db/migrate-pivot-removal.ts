import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";

/**
 * Jobs pivot - one-off migration that archives and removes the project /
 * spotlight marketplace tables while preserving every money record.
 *
 * Run:  npx tsx src/db/migrate-pivot-removal.ts           (dry-run: prints guard + plan)
 *       npx tsx src/db/migrate-pivot-removal.ts --apply   (runs inside one transaction)
 *
 * Ordering contract (asserted by migrate-pivot-removal.test.ts):
 *   1. guard      - abort if any project escrow is non-final
 *   2. archive    - CTAS copies of every row that will be deleted
 *   3. drop-fk    - FK constraints dropped before any delete/drop
 *   4. delete     - archived rows removed from surviving tables
 *   5. drop-table - the five project tables
 *   6. drop-type  - milestone_status enum
 *
 * Money tables (orders, community_orders, post_boosts, transactions,
 * services, wallet, withdrawals, referrals, disputes, saved_items,
 * invites, reports rows outside PROJECT) are never dropped.
 */

export const DROPPED_TABLES = [
  "project_milestones",
  "project_invites",
  "project_deliverables",
  "project_bids",
  "projects",
] as const;

export const DROPPED_TYPE = "milestone_status";

export const GUARD_SQL = `
SELECT id, status, escrow_amount, escrow_held_at
FROM projects
WHERE escrow_held_at IS NOT NULL
  AND status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY escrow_held_at`;

export const ARCHIVE_CTAS: string[] = [
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_projects') IS NULL
     AND to_regclass('public.projects') IS NOT NULL THEN
    CREATE TABLE archive_projects AS SELECT * FROM projects;
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_project_bids') IS NULL
     AND to_regclass('public.project_bids') IS NOT NULL THEN
    CREATE TABLE archive_project_bids AS SELECT * FROM project_bids;
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_project_deliverables') IS NULL
     AND to_regclass('public.project_deliverables') IS NOT NULL THEN
    CREATE TABLE archive_project_deliverables AS SELECT * FROM project_deliverables;
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_project_milestones') IS NULL
     AND to_regclass('public.project_milestones') IS NOT NULL THEN
    CREATE TABLE archive_project_milestones AS SELECT * FROM project_milestones;
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_project_invites') IS NULL
     AND to_regclass('public.project_invites') IS NOT NULL THEN
    CREATE TABLE archive_project_invites AS SELECT * FROM project_invites;
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_community_posts_gig_project') IS NULL
     AND to_regclass('public.community_posts') IS NOT NULL THEN
    CREATE TABLE archive_community_posts_gig_project AS
      SELECT * FROM community_posts WHERE kind IN ('GIG', 'PROJECT');
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_community_comments_gig_project') IS NULL
     AND to_regclass('public.community_comments') IS NOT NULL THEN
    CREATE TABLE archive_community_comments_gig_project AS
      SELECT c.* FROM community_comments c
      JOIN community_posts p ON p.id = c.post_id
      WHERE p.kind IN ('GIG', 'PROJECT');
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_community_likes_gig_project') IS NULL
     AND to_regclass('public.community_likes') IS NOT NULL
     AND to_regclass('public.community_posts') IS NOT NULL THEN
    CREATE TABLE archive_community_likes_gig_project AS
      SELECT l.* FROM community_likes l
      JOIN community_posts p ON p.id = l.post_id
      WHERE p.kind IN ('GIG', 'PROJECT');
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_saved_items_project') IS NULL
     AND to_regclass('public.saved_items') IS NOT NULL THEN
    CREATE TABLE archive_saved_items_project AS
      SELECT * FROM saved_items WHERE item_type = 'PROJECT';
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_invites_project') IS NULL
     AND to_regclass('public.invites') IS NOT NULL THEN
    CREATE TABLE archive_invites_project AS
      SELECT * FROM invites WHERE target_type = 'PROJECT';
  END IF;
END $pivot$;`,
  `DO $pivot$
BEGIN
  IF to_regclass('public.archive_reports_project') IS NULL
     AND to_regclass('public.reports') IS NOT NULL THEN
    CREATE TABLE archive_reports_project AS
      SELECT * FROM reports WHERE target_type = 'PROJECT';
  END IF;
END $pivot$;`,
];

export const ARCHIVE_COUNTS: { label: string; sql: string }[] = [
  { label: "projects", sql: "SELECT count(*)::int AS n FROM projects" },
  { label: "project_bids", sql: "SELECT count(*)::int AS n FROM project_bids" },
  { label: "project_deliverables", sql: "SELECT count(*)::int AS n FROM project_deliverables" },
  { label: "project_milestones", sql: "SELECT count(*)::int AS n FROM project_milestones" },
  { label: "project_invites", sql: "SELECT count(*)::int AS n FROM project_invites" },
  { label: "community_posts (GIG/PROJECT)", sql: "SELECT count(*)::int AS n FROM community_posts WHERE kind IN ('GIG', 'PROJECT')" },
  { label: "saved_items (PROJECT)", sql: "SELECT count(*)::int AS n FROM saved_items WHERE item_type = 'PROJECT'" },
  { label: "invites (PROJECT)", sql: "SELECT count(*)::int AS n FROM invites WHERE target_type = 'PROJECT'" },
  { label: "reports (PROJECT)", sql: "SELECT count(*)::int AS n FROM reports WHERE target_type = 'PROJECT'" },
];

/**
 * Dynamic FK removal. Constraint names are Postgres-generated, so they are
 * discovered from pg_constraint at run time:
 *   (i)  every FK on or referencing the five dropped tables
 *   (ii) the two money-table FKs that point at community_posts
 *        (community_orders.post_id, post_boosts.post_id) - the columns stay
 *        as legacy references, only the constraint goes, so deleting
 *        GIG/PROJECT posts cannot cascade into paid orders or paid boosts.
 */
export const DROP_FK_DO_BLOCK = `
DO $pivot$
DECLARE
  r    RECORD;
  t    TEXT;
  tgt  REGCLASS;
  posts REGCLASS;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'project_bids', 'project_deliverables', 'project_milestones', 'project_invites'] LOOP
    tgt := to_regclass('public.' || t);
    IF tgt IS NULL THEN
      CONTINUE;
    END IF;
    FOR r IN
      SELECT conrelid::regclass AS atbl, conname
      FROM pg_constraint
      WHERE contype = 'f'
        AND (conrelid = tgt OR confrelid = tgt)
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.atbl::text, r.conname);
    END LOOP;
  END LOOP;

  posts := to_regclass('public.community_posts');
  IF posts IS NOT NULL THEN
    FOREACH t IN ARRAY ARRAY['community_orders', 'post_boosts'] LOOP
      tgt := to_regclass('public.' || t);
      IF tgt IS NULL THEN
        CONTINUE;
      END IF;
      FOR r IN
        SELECT conrelid::regclass AS atbl, conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = tgt
          AND confrelid = posts
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.atbl::text, r.conname);
      END LOOP;
    END LOOP;
  END IF;
END $pivot$;`;

export const ROW_DELETES: string[] = [
  "DELETE FROM community_posts WHERE kind IN ('GIG', 'PROJECT');",
  "DELETE FROM saved_items WHERE item_type = 'PROJECT';",
  "DELETE FROM invites WHERE target_type = 'PROJECT';",
  "DELETE FROM reports WHERE target_type = 'PROJECT';",
];

export const DROP_TABLE_SQL = DROPPED_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n");

export const DROP_TYPE_SQL = `DROP TYPE IF EXISTS ${DROPPED_TYPE};`;

export type PivotPhase = "guard" | "archive" | "drop-fk" | "delete" | "drop-table" | "drop-type";

export interface PivotRemovalStep {
  phase: PivotPhase;
  sql: string;
}

export function buildPivotRemovalPlan(): PivotRemovalStep[] {
  return [
    { phase: "guard", sql: GUARD_SQL },
    ...ARCHIVE_CTAS.map((sql) => ({ phase: "archive" as const, sql })),
    { phase: "drop-fk", sql: DROP_FK_DO_BLOCK },
    ...ROW_DELETES.map((sql) => ({ phase: "delete" as const, sql })),
    { phase: "drop-table", sql: DROP_TABLE_SQL },
    { phase: "drop-type", sql: DROP_TYPE_SQL },
  ];
}

export class EscrowGuardError extends Error {
  constructor(public readonly rows: { id: string; status: string; escrow_amount: number; escrow_held_at: Date }[]) {
    super(
      `Refusing to run: ${rows.length} project(s) still hold non-final escrow. ` +
        `Finish (complete/cancel) them first: ${rows.map((r) => r.id).join(", ")}`,
    );
    this.name = "EscrowGuardError";
  }
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const res = await client.query(`SELECT to_regclass('public.${table}') AS t`);
  return res.rows[0]?.t != null;
}

export async function runPivotRemoval(opts: { apply: boolean }): Promise<void> {
  const { pool } = await import("./index");
  const client = await pool.connect();
  try {
    const plan = buildPivotRemovalPlan();

    const hasProjects = await tableExists(client, "projects");
    let blocked: { id: string; status: string; escrow_amount: number; escrow_held_at: Date }[] = [];
    if (hasProjects) {
      const guard = await client.query(GUARD_SQL);
      blocked = guard.rows as typeof blocked;
    }

    console.log(`pivot-removal ${opts.apply ? "--apply" : "(dry-run)"}: ${plan.length} plan steps`);
    console.log(`guard: ${hasProjects ? (blocked.length === 0 ? "PASS (no non-final escrow)" : `BLOCKED (${blocked.length} row(s))`) : "SKIP (projects table already gone)"}`);
    for (const row of blocked) {
      console.log(`  - ${row.id} status=${row.status} escrow=${row.escrow_amount} held_at=${row.escrow_held_at}`);
    }

    if (!opts.apply) {
      for (const { label, sql } of ARCHIVE_COUNTS) {
        try {
          const res = await client.query(sql);
          console.log(`  archive source ${label}: ${res.rows[0]?.n ?? "?"} row(s)`);
        } catch {
          console.log(`  archive source ${label}: table missing (already migrated)`);
        }
      }
      let i = 0;
      for (const step of plan) {
        console.log(`  [${String(++i).padStart(2, "0")}] ${step.phase}`);
      }
      if (blocked.length > 0) {
        throw new EscrowGuardError(blocked);
      }
      console.log("dry-run complete - re-run with --apply to execute.");
      return;
    }

    if (blocked.length > 0) {
      throw new EscrowGuardError(blocked);
    }

    await client.query("BEGIN");
    try {
      for (const step of plan) {
        if (step.phase === "guard") continue;
        await client.query(step.sql);
      }
      await client.query("COMMIT");
      console.log("pivot-removal applied successfully.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry == null) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const apply = process.argv.includes("--apply");
  runPivotRemoval({ apply }).catch((err) => {
    console.error(`pivot-removal FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
