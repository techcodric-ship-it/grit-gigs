// Seed/verification script for GritScore.
//
// Runs entirely in memory: it imports the same pure scoring module the API
// uses, builds five representative profiles, and prints the score each one
// earns. This is how you sanity-check a weight or evidence-value change
// without touching production data.
//
//   npx tsx scripts/seed-gritscore.ts
//
// Pass --json for machine-readable output.

import {
  DEFAULT_CONFIG,
  EVIDENCE_VALUE,
  type EvidenceType,
  type VerificationTier,
} from "../src/gritscore/config";
import { buildTips, computeScore, componentBreakdown, type ScoreItemInput } from "../src/gritscore/score";
import { verificationLabel } from "../src/gritscore/verify";

interface SeedProfile {
  name: string;
  headline: string;
  verificationTier: VerificationTier;
  items: (ScoreItemInput & { title: string })[];
}

const profile = (
  name: string,
  headline: string,
  verificationTier: VerificationTier,
  items: (ScoreItemInput & { title: string })[],
): SeedProfile => ({ name, headline, verificationTier, items });

const item = (
  title: string,
  over: Partial<ScoreItemInput> & { evidenceType: EvidenceType },
): ScoreItemInput & { title: string } => ({
  title,
  complexity: 3,
  clarity: 3,
  hasQuantifiedImpact: false,
  skills: [],
  startDate: null,
  endDate: null,
  ...over,
});

export const SEED_PROFILES: SeedProfile[] = [
  // 1. Nothing but claims. Expect Starter and a self-reported cap message.
  profile("Rohit — no evidence", "Aspiring developer", "self_reported", [
    item("Some freelance work", {
      evidenceType: "none",
      complexity: 1,
      clarity: 2,
      hasQuantifiedImpact: false,
      skills: ["html"],
    }),
    item("Personal project", {
      evidenceType: "none",
      complexity: 1,
      clarity: 1,
      hasQuantifiedImpact: false,
    }),
  ]),

  // 2. Strong, fully evidenced, referee-confirmed. Expect Legend territory.
  profile("Asha — all strong", "Senior backend engineer", "third_party_confirmed", [
    item("Billing pipeline rewrite", {
      evidenceType: "github",
      complexity: 5,
      clarity: 5,
      hasQuantifiedImpact: true,
      skills: ["typescript", "postgresql", "stripe"],
      startDate: "2022-01",
      endDate: "2022-12",
    }),
    item("Payments reconciliation service", {
      evidenceType: "liveLink",
      complexity: 5,
      clarity: 5,
      hasQuantifiedImpact: true,
      skills: ["typescript", "postgresql", "redis"],
      startDate: "2023-01",
      endDate: "2023-12",
    }),
    item("Incident tooling", {
      evidenceType: "github",
      complexity: 4,
      clarity: 4,
      hasQuantifiedImpact: true,
      skills: ["typescript", "redis", "docker"],
      startDate: "2024-01",
      endDate: "2024-12",
    }),
  ]),

  // 3. Mixed: one excellent item, one file, one screenshot, one bare claim.
  profile("Meera — mixed evidence", "Product designer", "evidence_checked", [
    item("Design system for 8 products", {
      evidenceType: "liveLink",
      complexity: 5,
      clarity: 4,
      hasQuantifiedImpact: true,
      skills: ["design systems", "figma", "ui design"],
      startDate: "2021-01",
      endDate: "2022-06",
    }),
    item("Checkout redesign case study", {
      evidenceType: "file",
      complexity: 4,
      clarity: 4,
      hasQuantifiedImpact: false,
      skills: ["ux design", "figma"],
      startDate: "2022-07",
      endDate: "2023-03",
    }),
    item("Brand refresh", {
      evidenceType: "screenshot",
      complexity: 2,
      clarity: 3,
      hasQuantifiedImpact: false,
      skills: ["illustrator"],
      startDate: "2023-04",
      endDate: "2023-08",
    }),
    item("Some landing pages", {
      evidenceType: "none",
      complexity: 1,
      clarity: 2,
      hasQuantifiedImpact: false,
      skills: [],
    }),
  ]),

  // 4. Cap case: excellent arithmetic, but nothing verified. Expect exactly 600.
  profile("Kabir — capped at 600", "Full-stack developer", "self_reported", [
    item("Logistics dashboard", {
      evidenceType: "liveLink",
      complexity: 5,
      clarity: 5,
      hasQuantifiedImpact: true,
      skills: ["react", "node.js", "postgresql"],
      startDate: "2023-01",
      endDate: "2023-10",
    }),
    item("Route optimiser", {
      evidenceType: "github",
      complexity: 5,
      clarity: 5,
      hasQuantifiedImpact: true,
      skills: ["node.js", "postgresql"],
      startDate: "2023-11",
      endDate: "2024-06",
    }),
    item("Driver mobile app", {
      evidenceType: "published",
      complexity: 4,
      clarity: 5,
      hasQuantifiedImpact: true,
      skills: ["react native", "node.js"],
      startDate: "2024-07",
      endDate: "2025-01",
    }),
  ]),

  // 5. Entry-level but honest: two small, real, proven pieces.
  profile("Divya — early career", "Junior data analyst", "evidence_checked", [
    item("Sales dashboard in Power BI", {
      evidenceType: "file",
      complexity: 2,
      clarity: 3,
      hasQuantifiedImpact: true,
      skills: ["power bi", "excel", "sql"],
      startDate: "2025-01",
      endDate: "2025-03",
    }),
    item("Cleaned 12k-row dataset", {
      evidenceType: "github",
      complexity: 2,
      clarity: 2,
      hasQuantifiedImpact: true,
      skills: ["python", "sql"],
      startDate: "2025-04",
      endDate: "2025-05",
    }),
  ]),
];

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function main(): void {
  const asJson = process.argv.includes("--json");

  if (asJson) {
    const out = SEED_PROFILES.map((p) => {
      const input = { items: p.items, verificationTier: p.verificationTier };
      const result = computeScore(input, DEFAULT_CONFIG);
      return {
        name: p.name,
        headline: p.headline,
        verificationTier: p.verificationTier,
        score: result.score,
        rawScore: result.rawScore,
        capped: result.capped,
        tier: result.tier,
        components: result.components,
        breakdown: componentBreakdown(result),
        tips: buildTips(result, p.items),
      };
    });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  process.stdout.write("GritScore seed profiles\n");
  process.stdout.write("=".repeat(96) + "\n\n");

  for (const p of SEED_PROFILES) {
    const result = computeScore({ items: p.items, verificationTier: p.verificationTier }, DEFAULT_CONFIG);
    process.stdout.write(`${p.name}  —  ${p.headline}\n`);
    process.stdout.write(`  score ${result.score}/900  (raw ${result.rawScore})  tier ${pad(result.tier, 8)} ${verificationLabel(p.verificationTier)}\n`);
    if (result.capped) process.stdout.write(`  capped at ${result.cap}: self-reported work cannot exceed 600\n`);
    const parts = componentBreakdown(result)
      .map((c) => `${c.label} ${c.percent}%`)
      .join("  ·  ");
    process.stdout.write(`  ${parts}\n`);
    process.stdout.write(`  items ${p.items.length}  ·  weighted ${(result.weightedSum * 100).toFixed(1)}%\n`);
    const tips = buildTips(result, p.items).slice(0, 2);
    for (const tip of tips) process.stdout.write(`  tip: ${tip}\n`);
    process.stdout.write("\n");
  }

  process.stdout.write("=".repeat(96) + "\n");
  process.stdout.write("Evidence values: " + Object.entries(EVIDENCE_VALUE).map(([k, v]) => `${k} ${v}`).join(", ") + "\n");
  process.stdout.write("Tier cutoffs: " + DEFAULT_CONFIG.tiers.map((t) => `${t.name} ${t.min}`).join(", ") + "\n");
}

main();
