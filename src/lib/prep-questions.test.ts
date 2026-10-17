import { describe, it, expect } from "vitest";
import {
  MAX_ANSWER_LEN,
  PREP_TRACKS,
  checklistFeedback,
  findQuestion,
  isPrepTrack,
  parseCoachJson,
  questionsForTrack,
} from "./prep-questions";

describe("prep tracks & bank", () => {
  it("exposes unique track ids", () => {
    const ids = PREP_TRACKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every track has at least 5 questions with unique ids", () => {
    const all = PREP_TRACKS.flatMap((t) => questionsForTrack(t.id));
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    for (const t of PREP_TRACKS) {
      expect(questionsForTrack(t.id).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("falls back to general for unknown tracks and validates tracks", () => {
    expect(questionsForTrack("nonsense").every((q) => q.track === "general")).toBe(true);
    expect(isPrepTrack("frontend")).toBe(true);
    expect(isPrepTrack("gig")).toBe(false);
    expect(findQuestion("backend-1")?.track).toBe("backend");
    expect(findQuestion(42)).toBeUndefined();
  });
});

describe("checklistFeedback", () => {
  it("never invents a score and labels the source as platform_checklist", () => {
    const f = checklistFeedback("short");
    expect(f.score).toBeNull();
    expect(f.source).toBe("platform_checklist");
    expect(f.feedback).toContain("not an AI score");
  });

  it("encourages a longer structured answer for very short replies", () => {
    const f = checklistFeedback("I did things.");
    expect(f.feedback).toMatch(/longer|sentences/i);
  });
});

describe("parseCoachJson", () => {
  it("parses a plain JSON object and clamps scores", () => {
    const p = parseCoachJson('{"score": 130, "strengths": ["clear"], "improvements": ["add metrics"], "tip": "Quantify impact."}');
    expect(p?.score).toBe(100);
    expect(p?.strengths).toEqual(["clear"]);
    expect(p?.tip).toBe("Quantify impact.");
  });

  it("unwraps fenced JSON and ignores junk around it", () => {
    const p = parseCoachJson('Here you go:\n```json\n{"score": 72, "strengths": ["structure"], "improvements": [], "tip": ""}\n```\nDone.');
    expect(p?.score).toBe(72);
  });

  it("returns null on unusable input", () => {
    expect(parseCoachJson("not json")).toBeNull();
    expect(parseCoachJson("{[")).toBeNull();
  });

  it("accepts string scores and drops non-string list entries", () => {
    const p = parseCoachJson('{"score": "55", "strengths": ["ok", 3, null], "improvements": ["x"], "tip": 9}');
    expect(p?.score).toBe(55);
    expect(p?.strengths).toEqual(["ok"]);
    expect(p?.tip).toBe("");
  });
});

describe("answer length cap", () => {
  it("exposes a sane cap", () => {
    expect(MAX_ANSWER_LEN).toBeGreaterThanOrEqual(1000);
  });
});
