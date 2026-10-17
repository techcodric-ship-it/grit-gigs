import { describe, it, expect } from "vitest";
import {
  buildPivotRemovalPlan,
  GUARD_SQL,
  DROP_FK_DO_BLOCK,
  DROP_TABLE_SQL,
  DROP_TYPE_SQL,
  DROPPED_TABLES,
  DROPPED_TYPE,
  ROW_DELETES,
  ARCHIVE_CTAS,
} from "./migrate-pivot-removal";

const MONEY_TABLES = [
  "orders",
  "community_orders",
  "post_boosts",
  "boost_impressions",
  "transactions",
  "freelance_wallets",
  "withdrawal_requests",
  "services",
  "service_packages",
  "referrals",
  "disputes",
  "saved_items",
  "invites",
  "reports",
  "community_posts",
  "community_comments",
  "community_likes",
  "users",
];

describe("migrate-pivot-removal plan", () => {
  const plan = buildPivotRemovalPlan();

  it("starts with the escrow guard and keeps the fixed phase order", () => {
    const order = ["guard", "archive", "drop-fk", "delete", "drop-table", "drop-type"];
    const phases = plan.map((s) => s.phase);
    expect(phases[0]).toBe("guard");
    const rank = (p: string) => order.indexOf(p);
    for (let i = 1; i < phases.length; i++) {
      expect(rank(phases[i])).toBeGreaterThanOrEqual(rank(phases[i - 1]));
    }
    expect(phases).toContain("archive");
    expect(phases).toContain("drop-fk");
    expect(phases).toContain("delete");
  });

  it("guards on non-final project escrow before anything runs", () => {
    expect(GUARD_SQL).toMatch(/escrow_held_at IS NOT NULL/);
    expect(GUARD_SQL).toMatch(/status NOT IN \('COMPLETED', 'CANCELLED'\)/);
    expect(GUARD_SQL).not.toMatch(/DELETE|DROP|UPDATE|INSERT/i);
    expect(plan[0].sql).toBe(GUARD_SQL);
  });

  it("drops exactly the five project tables and nothing else", () => {
    expect([...DROPPED_TABLES].sort()).toEqual(
      ["project_bids", "project_deliverables", "project_invites", "project_milestones", "projects"].sort(),
    );
    const droppedStatements = DROP_TABLE_SQL.split("\n").filter(Boolean);
    expect(droppedStatements).toHaveLength(DROPPED_TABLES.length);
    for (const table of MONEY_TABLES) {
      expect(DROPPED_TABLES as readonly string[]).not.toContain(table);
      expect(DROP_TABLE_SQL).not.toMatch(new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
    }
  });

  it("drops only the milestone_status enum type", () => {
    expect(DROPPED_TYPE).toBe("milestone_status");
    expect(DROP_TYPE_SQL).toMatch(/^DROP TYPE IF EXISTS milestone_status;$/);
  });

  it("drops FK constraints before any delete or drop, discovered from pg_constraint", () => {
    const fkIndex = plan.findIndex((s) => s.phase === "drop-fk");
    const firstDelete = plan.findIndex((s) => s.phase === "delete");
    const firstDrop = plan.findIndex((s) => s.phase === "drop-table");
    expect(fkIndex).toBeGreaterThan(-1);
    expect(fkIndex).toBeLessThan(firstDelete);
    expect(fkIndex).toBeLessThan(firstDrop);

    expect(DROP_FK_DO_BLOCK).toMatch(/pg_constraint/);
    expect(DROP_FK_DO_BLOCK).toMatch(/contype = 'f'/);
    expect(DROP_FK_DO_BLOCK).toMatch(/conrelid = tgt OR confrelid = tgt/);
    expect(DROP_FK_DO_BLOCK).not.toMatch(/\bDELETE\b|\bDROP TABLE\b/i);
  });

  it("detaches money tables from community_posts before gig posts are deleted", () => {
    expect(DROP_FK_DO_BLOCK).toMatch(/community_orders/);
    expect(DROP_FK_DO_BLOCK).toMatch(/post_boosts/);
    expect(DROP_FK_DO_BLOCK).toMatch(/confrelid = posts/);

    const deleteSql = ROW_DELETES.join("\n");
    expect(deleteSql).toMatch(/DELETE FROM community_posts WHERE kind IN \('GIG', 'PROJECT'\)/);
    const fkIndex = plan.findIndex((s) => s.phase === "drop-fk");
    const postDelete = plan.findIndex((s) => s.sql.includes("DELETE FROM community_posts"));
    expect(postDelete).toBeGreaterThan(fkIndex);
  });

  it("archives every row it deletes, including cascade-shaped history", () => {
    const archives = ARCHIVE_CTAS.join("\n");
    for (const table of DROPPED_TABLES) {
      expect(archives).toContain(`CREATE TABLE archive_${table} AS SELECT * FROM ${table}`);
    }
    expect(archives).toContain("archive_community_posts_gig_project");
    expect(archives).toContain("archive_community_comments_gig_project");
    expect(archives).toContain("archive_community_likes_gig_project");
    expect(archives).toContain("archive_saved_items_project");
    expect(archives).toContain("archive_invites_project");
    expect(archives).toContain("archive_reports_project");

    const firstArchive = plan.findIndex((s) => s.phase === "archive");
    const lastArchive = plan.map((s) => s.phase).lastIndexOf("archive");
    const firstDelete = plan.findIndex((s) => s.phase === "delete");
    expect(firstArchive).toBeGreaterThan(0);
    expect(lastArchive).toBeLessThan(firstDelete);
  });

  it("never deletes from money tables", () => {
    const targets = ROW_DELETES.map((s) => {
      const m = /^DELETE FROM (\w+)/.exec(s);
      return m?.[1];
    });
    expect(targets).toEqual(["community_posts", "saved_items", "invites", "reports"]);
    for (const sql of ROW_DELETES) {
      expect(sql).not.toMatch(/orders|transactions|wallet|withdrawal|services|disputes|referrals/i);
    }
    expect(ROW_DELETES.join(" ")).not.toMatch(/DELETE FROM community_(orders|comments|likes)/);
  });
});
