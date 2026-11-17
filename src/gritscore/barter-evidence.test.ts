import { describe, expect, it } from "vitest";
import {
  BARTER_EVIDENCE_CAP,
  buildBarterDrafts,
  type DeliveryRow,
  type MatchRow,
  type RequestRow,
  type ReviewRow,
} from "./barter-evidence";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";
const REQ_MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ_THEIRS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MATCH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const match = (over: Partial<MatchRow> = {}): MatchRow => ({
  id: MATCH,
  request1Id: REQ_MINE,
  request2Id: REQ_THEIRS,
  user1Id: ME,
  user2Id: THEM,
  status: "COMPLETED",
  completedAt: new Date("2026-05-04T10:00:00Z"),
  createdAt: new Date("2026-05-01T10:00:00Z"),
  ...over,
});

const requests: RequestRow[] = [
  { id: REQ_MINE, userId: ME, skillOffered: "React, Node.js", skillNeeded: "Illustration" },
  { id: REQ_THEIRS, userId: THEM, skillOffered: "Illustration", skillNeeded: "React" },
];

const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  matchId: MATCH,
  userId: ME,
  link: "https://drive.google.com/file/d/my-work",
  createdAt: new Date("2026-05-03T10:00:00Z"),
  ...over,
});

const review = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  matchId: MATCH,
  rating: 5,
  comment: "Great collaborator, delivered on time.",
  createdAt: new Date("2026-05-06T10:00:00Z"),
  ...over,
});

const build = (over: Partial<Parameters<typeof buildBarterDrafts>[0]> = {}) =>
  buildBarterDrafts({ userId: ME, matches: [], requests, deliveries: [], reviews: [], ...over });

describe("barter evidence conversion", () => {
  it("ignores matches that were not completed by both parties", () => {
    expect(build({ matches: [match({ status: "IN_PROGRESS" })] })).toEqual([]);
    expect(build({ matches: [match({ status: "COMPLETED" })] })).toHaveLength(1);
  });

  it("composes the title from the owner's own request and records a verified deal", () => {
    const [draft] = build({ matches: [match()] });
    expect(draft).toMatchObject({
      sourceRef: `barter:match:${MATCH}`,
      evidenceType: "barter_completion",
      role: "Barter completion",
      startDate: "2026-05-04",
      endDate: "2026-05-04",
      evidenceStatus: "ok",
      skills: ["react", "node.js", "illustration"],
    });
    expect(draft.title).toContain("React");
    expect(draft.title).toContain("Illustration");
    expect(draft.description).toContain("Both parties accepted");
    expect(draft.description.length).toBeGreaterThanOrEqual(10);
  });

  it("never leaks counterparty ids into any output field", () => {
    const drafts = build({ matches: [match()], reviews: [review()] });
    const serialised = JSON.stringify(drafts);
    expect(serialised).not.toContain(THEM);
    expect(serialised).not.toContain(REQ_THEIRS);
    expect(Object.keys(drafts[1])).not.toContain("reviewerId");
  });

  it("uses only the owner's own, public delivery link as proof", () => {
    const [draft] = build({
      matches: [match()],
      deliveries: [
        delivery({ link: "http://127.0.0.1/admin", createdAt: new Date("2026-05-05T10:00:00Z") }),
        delivery({ id: "theirs", userId: THEM, link: "https://example.com/theirs", createdAt: new Date("2026-05-06T10:00:00Z") }),
      ],
    });
    expect(draft.proofUrl).toBeNull();

    const [other] = build({
      matches: [match()],
      deliveries: [delivery({ link: "https://example.com/mine" })],
    });
    expect(other.proofUrl).toBe("https://example.com/mine");
  });

  it("caps proof URLs at 600 characters and drops non-http links", () => {
    const long = "https://example.com/" + "x".repeat(700);
    const [draft] = build({ matches: [match()], deliveries: [delivery({ link: long })] });
    expect(draft.proofUrl).toHaveLength(600);
    expect(build({ matches: [match()], deliveries: [delivery({ link: "/uploads/private" })] })[0].proofUrl).toBeNull();
  });

  it("deduplicates by sourceRef and honours the slot limit", () => {
    const drafts = build({
      matches: [match(), match()],
      reviews: [review(), review({ id: "second" })],
      limit: 3,
    });
    const refs = drafts.map((d) => d.sourceRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(drafts).toHaveLength(3);
    expect(drafts[0].evidenceType).toBe("barter_completion");
    expect(drafts.filter((d) => d.evidenceType === "barter_review")).toHaveLength(2);
  });

  it("caps derived evidence even when a huge limit is supplied", () => {
    const matches = Array.from({ length: 6 }, (_, i) => match({ id: `match-${i}` }));
    const drafts = build({ matches, limit: 100 });
    expect(drafts).toHaveLength(BARTER_EVIDENCE_CAP);
  });

  it("turns received reviews into bounded feedback evidence", () => {
    const [draft] = build({ reviews: [review({ rating: 99, comment: null })] });
    expect(draft).toMatchObject({
      sourceRef: `barter:review:${review().id}`,
      evidenceType: "barter_review",
      role: "Barter review",
      evidenceStatus: "ok",
      proofUrl: null,
      skills: [],
    });
    expect(draft.description).toContain("5/5");
    expect(draft.description).toContain("No written comment");
  });

  it("returns nothing for an owner with no barter history", () => {
    expect(build()).toEqual([]);
    expect(build({ limit: 0, matches: [match()], reviews: [review()] })).toEqual([]);
  });
});
