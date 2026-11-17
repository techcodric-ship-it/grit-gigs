// Pure conversion of completed barter deals / received reviews into GritScore
// evidence drafts. No DB access here: the read-only fetch lives in
// barter-evidence-db.ts. Counterparty ids, names and review authors are never
// read or returned, so a public card cannot leak the other side of a barter.

import { isFetchableUrl, normaliseUrl } from "./evidence";

export type BarterEvidenceType = "barter_completion" | "barter_review";

/** A GritScore-side item derived from a barter outcome. `sourceRef` is stable
 *  across rescans so a refresh can upsert instead of duplicating a deal. */
export interface BarterEvidenceDraft {
  sourceRef: string;
  evidenceType: BarterEvidenceType;
  title: string;
  description: string;
  role: string;
  startDate: string | null;
  endDate: string | null;
  proofUrl: string | null;
  skills: string[];
  evidenceStatus: "ok";
  evidenceNote: string;
}

/** Structural row shapes so the conversion can be unit-tested without a DB. */
export interface MatchRow {
  id: string;
  request1Id: string;
  request2Id: string;
  user1Id: string;
  user2Id: string;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
}

export interface RequestRow {
  id: string;
  userId: string;
  skillOffered: string;
  skillNeeded: string;
}

export interface DeliveryRow {
  id: string;
  matchId: string;
  userId: string;
  link: string | null;
  createdAt: Date;
}

export interface ReviewRow {
  id: string;
  matchId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
}

/** At most four derived items: a card holds eight items total and at least one
 *  must be owner-written, so barter evidence can never take over the card. */
export const BARTER_EVIDENCE_CAP = 4;

function ymd(value: Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function cleanSkill(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function skillsFrom(...values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of String(value ?? "").split(/[,\n;|]+/)) {
      const skill = part.trim().toLowerCase().slice(0, 60);
      if (!skill || seen.has(skill)) continue;
      seen.add(skill);
      out.push(skill);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/** Only the owner's own public delivery link is ever reused as proof. It must
 *  be a http(s) URL that passes the same SSRF guard as uploaded proof links. */
function safeDeliveryUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = String(raw).trim().slice(0, 600);
  if (!normaliseUrl(value) || !isFetchableUrl(value)) return null;
  return value;
}

export interface BuildBarterDraftsArgs {
  userId: string;
  matches: MatchRow[];
  requests: RequestRow[];
  deliveries: DeliveryRow[];
  reviews: ReviewRow[];
  limit?: number;
}

/** Pure conversion, safe to unit-test. Completions come before reviews so the
 *  stronger evidence wins when the card has limited slots. */
export function buildBarterDrafts({
  userId,
  matches,
  requests,
  deliveries,
  reviews,
  limit = BARTER_EVIDENCE_CAP,
}: BuildBarterDraftsArgs): BarterEvidenceDraft[] {
  const cap = Math.max(0, Math.min(Math.floor(limit), BARTER_EVIDENCE_CAP));
  if (cap === 0) return [];

  const requestById = new Map(requests.map((r) => [r.id, r]));
  const drafts: BarterEvidenceDraft[] = [];
  const seen = new Set<string>();

  const push = (draft: BarterEvidenceDraft) => {
    if (seen.has(draft.sourceRef) || drafts.length >= cap) return;
    seen.add(draft.sourceRef);
    drafts.push(draft);
  };

  for (const match of matches) {
    if (match.status !== "COMPLETED") continue;
    const mine =
      requestById.get(match.request1Id)?.userId === userId
        ? requestById.get(match.request1Id)
        : requestById.get(match.request2Id)?.userId === userId
          ? requestById.get(match.request2Id)
          : undefined;
    const offered = cleanSkill(mine?.skillOffered);
    const needed = cleanSkill(mine?.skillNeeded);
    const delivery = deliveries
      .filter((d) => d.matchId === match.id && d.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const date = ymd(match.completedAt ?? match.createdAt);

    push({
      sourceRef: `barter:match:${match.id}`,
      evidenceType: "barter_completion",
      title: mine ? `${offered || "A skill"} ↔ ${needed || "a skill"}`.slice(0, 200) : "Completed barter exchange",
      description: mine
        ? `Completed a barter exchange on Grit&Gigs: offered ${offered || "a skill"} and received ${needed || "a skill"}. Both parties accepted the deliverables.`.slice(0, 500)
        : "Completed a barter exchange on Grit&Gigs. Both parties accepted the deliverables.",
      role: "Barter completion",
      startDate: date,
      endDate: date,
      proofUrl: safeDeliveryUrl(delivery?.link),
      skills: skillsFrom(offered, needed),
      evidenceStatus: "ok",
      evidenceNote: "Both parties accepted this barter",
    });
  }

  for (const review of reviews) {
    const rating = Math.min(5, Math.max(1, Math.trunc(Number(review.rating) || 0)));
    const comment = String(review.comment ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const date = ymd(review.createdAt);
    push({
      sourceRef: `barter:review:${review.id}`,
      evidenceType: "barter_review",
      title: "Barter review received",
      description: `${rating}/5 from a barter counterpart. ${comment || "No written comment was left."}`.slice(0, 500),
      role: "Barter review",
      startDate: date,
      endDate: date,
      proofUrl: null,
      skills: [],
      evidenceStatus: "ok",
      evidenceNote: "Review received on a completed barter",
    });
  }

  return drafts;
}
