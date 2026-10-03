import { describe, it, expect } from "vitest";
import { likeTerm, suggestRank, matchesTerm, rankTerms } from "./search-suggest";

// The behaviour the user asked for: typing part of a term has to find it.
// "web" and "web de" must both surface "web development".

describe("likeTerm", () => {
  it("wraps the query for a substring match", () => {
    expect(likeTerm("web")).toBe("%web%");
  });

  it("escapes the percent sign so it is not a wildcard", () => {
    // Unescaped, this pattern matches every row in the table.
    expect(likeTerm("100%")).toBe("%100\\%%");
  });

  it("escapes the underscore so it is not a single-character wildcard", () => {
    expect(likeTerm("a_b")).toBe("%a\\_b%");
  });

  it("escapes the backslash itself", () => {
    expect(likeTerm("a\\b")).toBe("%a\\\\b%");
  });

  it("leaves ordinary text untouched", () => {
    expect(likeTerm("web development")).toBe("%web development%");
  });
});

describe("partial matching", () => {
  it("finds a term from just its first few letters", () => {
    expect(matchesTerm("web development", "web")).toBe(true);
    expect(matchesTerm("web development", "web d")).toBe(true);
    expect(matchesTerm("web development", "development")).toBe(true);
    expect(matchesTerm("web development", "devel")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesTerm("Web Development", "web")).toBe(true);
    expect(matchesTerm("web development", "WEB")).toBe(true);
  });

  it("still rejects unrelated terms", () => {
    expect(matchesTerm("logo design", "web")).toBe(false);
  });
});

describe("suggestRank", () => {
  it("puts an exact match first", () => {
    expect(suggestRank("web", "web")).toBe(0);
  });

  it("ranks a term that starts with the query above one that merely contains it", () => {
    const startsWith = suggestRank("web development", "web");
    const inside = suggestRank("responsive web", "web");
    expect(startsWith).toBeLessThan(inside);
  });

  it("does not treat a mid-word substring as a word start", () => {
    // "web" inside "network" is a weaker match than "web" at the start of a word.
    expect(suggestRank("network", "web")).toBeGreaterThan(suggestRank("web hosting", "web"));
  });

  it("returns a worse rank than any match for a term that does not match", () => {
    // "web" is only a mid-word substring in "responsive web"; "logo design" does
    // not contain it at all, so it must rank worse.
    expect(suggestRank("logo design", "web")).toBeGreaterThan(suggestRank("responsive web", "web"));
  });
});

describe("rankTerms", () => {
  const rows = [
    { term: "responsive web", n: 9 },
    { term: "website", n: 4 },
    { term: "web development", n: 3 },
    { term: "logo design", n: 50 },
    { term: "web", n: 1 },
  ];

  it("returns the terms a partial query is looking for", () => {
    const out = rankTerms(rows, "web", 10);
    expect(out).toContain("web development");
    expect(out).toContain("website");
  });

  it("drops terms that do not match at all", () => {
    expect(rankTerms(rows, "web", 10)).not.toContain("logo design");
  });

  it("leads with the exact match, then prefix matches, then mid-word ones", () => {
    const out = rankTerms(rows, "web", 10);
    // Someone who typed "web" and is shown "website" has not been answered yet.
    expect(out[0]).toBe("web");
    expect(out.indexOf("web development")).toBeLessThan(out.indexOf("responsive web"));
    expect(out.indexOf("website")).toBeLessThan(out.indexOf("responsive web"));
  });

  it("finds the term from a mid-phrase fragment", () => {
    expect(rankTerms(rows, "web d", 10)).toEqual(["web development"]);
  });

  it("de-duplicates repeated terms", () => {
    const dupes = [
      { term: "web development", n: 2 },
      { term: "web development", n: 1 },
    ];
    expect(rankTerms(dupes, "web", 10)).toEqual(["web development"]);
  });

  it("respects the limit", () => {
    expect(rankTerms(rows, "web", 2)).toHaveLength(2);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(rankTerms(rows, "zzz", 6)).toEqual([]);
  });
});