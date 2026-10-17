import { describe, it, expect } from "vitest";

// skills.ts is pure (no db import), so it can be loaded directly.
import {
  JOB_TYPES,
  MAX_JOB_SKILLS,
  SKILLS_TAXONOMY,
  canManageJob,
  isValidJobType,
  normalizeSkillInput,
  parseJobListQuery,
} from "./skills";

describe("normalizeSkillInput", () => {
  it("trims, drops empties and de-dupes case-insensitively", () => {
    expect(normalizeSkillInput([" React ", "react", "Node.js", "", "  ", "node.JS"])).toEqual([
      "React",
      "Node.js",
    ]);
  });

  it("ignores non-strings and caps at MAX_JOB_SKILLS", () => {
    const raw = [...Array.from({ length: 20 }, (_, i) => `skill-${i}`), 42, null, { a: 1 }];
    const out = normalizeSkillInput(raw);
    expect(out).toHaveLength(MAX_JOB_SKILLS);
    expect(out[0]).toBe("skill-0");
  });

  it("returns [] for non-array input", () => {
    expect(normalizeSkillInput("react")).toEqual([]);
    expect(normalizeSkillInput(undefined)).toEqual([]);
    expect(normalizeSkillInput(null)).toEqual([]);
  });

  it("truncates individual skills to 60 chars", () => {
    const out = normalizeSkillInput(["x".repeat(200)]);
    expect(out[0]).toHaveLength(60);
  });
});

describe("parseJobListQuery", () => {
  it("keeps only known, non-empty, trimmed params", () => {
    expect(parseJobListQuery({ q: " designer ", skill: "Figma", type: "Full-time", location: "Pune", junk: "x" })).toEqual({
      q: "designer",
      skill: "Figma",
      type: "Full-time",
      location: "Pune",
    });
  });

  it("drops unknown job types and over-long values", () => {
    expect(parseJobListQuery({ type: "Gig", q: "a".repeat(500) })).toEqual({ q: "a".repeat(120) });
  });

  it("ignores empty and non-string params", () => {
    expect(parseJobListQuery({ q: "   ", skill: 3, location: ["a"] })).toEqual({});
  });
});

describe("canManageJob", () => {
  it("lets the poster manage their job", () => {
    expect(canManageJob({ postedById: "u1" }, { id: "u1", role: "USER" })).toBe(true);
  });

  it("blocks other regular users and unowned jobs", () => {
    expect(canManageJob({ postedById: "u1" }, { id: "u2", role: "USER" })).toBe(false);
    expect(canManageJob({ postedById: null }, { id: "u1", role: "USER" })).toBe(false);
  });

  it("lets admins and moderators manage any job", () => {
    expect(canManageJob({ postedById: "u1" }, { id: "x", role: "ADMIN" })).toBe(true);
    expect(canManageJob({ postedById: null }, { id: "x", role: "MODERATOR" })).toBe(true);
  });
});

describe("taxonomy & types", () => {
  it("has a unique, non-empty skills taxonomy", () => {
    const lowered = SKILLS_TAXONOMY.map((s) => s.toLowerCase());
    expect(new Set(lowered).size).toBe(SKILLS_TAXONOMY.length);
    for (const s of SKILLS_TAXONOMY) expect(s.trim()).toBe(s);
  });

  it("validates job types against the allowlist", () => {
    for (const t of JOB_TYPES) expect(isValidJobType(t)).toBe(true);
    expect(isValidJobType("Gig")).toBe(false);
    expect(isValidJobType(123)).toBe(false);
  });
});
