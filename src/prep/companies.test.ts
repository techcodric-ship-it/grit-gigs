// Pure-function tests for Prep company normalization, slugging, domains and
// candidate ranking. No DB involved.

import { describe, it, expect } from "vitest";
import {
  normalizeCompanyName,
  slugifyCompanyName,
  domainFromWebsite,
  scoreCompany,
  pickCandidates,
} from "./companies";
import type { PrepCompany } from "./schema";

const company = (name: string, aliases: string[] = []): PrepCompany =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    slug: slugifyCompanyName(name) || "c",
    name,
    aliases,
    domain: null,
    website: null,
    status: "ACTIVE",
    verifiedClaimedBy: null,
    createdBy: null,
    createdAt: new Date(0),
  }) as PrepCompany;

describe("normalizeCompanyName", () => {
  it("lowercases and trims", () => {
    expect(normalizeCompanyName("  Infosys ")).toBe("infosys");
  });
  it("strips trailing legal suffixes", () => {
    expect(normalizeCompanyName("Infosys Limited")).toBe("infosys");
    expect(normalizeCompanyName("Tata Consultancy Services Pvt Ltd")).toBe("tata consultancy services");
    expect(normalizeCompanyName("Acme Inc.")).toBe("acme");
  });
  it("treats & as and and drops odd characters", () => {
    expect(normalizeCompanyName("HUL & Co")).toBe("hul and"); // trailing "Co" is a legal suffix
    expect(normalizeCompanyName("Foo & Bar Ltd")).toBe("foo and bar");
    expect(normalizeCompanyName("Foo@Bar!")).toBe("foo bar");
  });
  it("does not eat the whole name", () => {
    expect(normalizeCompanyName("Limited")).toBe("limited");
    expect(normalizeCompanyName("")).toBe("");
  });
});

describe("slugifyCompanyName", () => {
  it("joins normalized words with hyphens", () => {
    expect(slugifyCompanyName("Tata Consultancy Services Limited")).toBe("tata-consultancy-services");
  });
  it("returns empty for unusable input", () => {
    expect(slugifyCompanyName("   ")).toBe("");
  });
});

describe("domainFromWebsite", () => {
  it("extracts hostname without www", () => {
    expect(domainFromWebsite("https://www.Infosys.com/about")).toBe("infosys.com");
    expect(domainFromWebsite("infosys.com")).toBe("infosys.com");
  });
  it("returns null for junk", () => {
    expect(domainFromWebsite(null)).toBeNull();
    expect(domainFromWebsite("not a url ???")).toBeNull();
  });
});

describe("scoreCompany / pickCandidates", () => {
  const acme = company("Acme Corp", ["acme"]);
  const acmeLabs = company("Acme Labs Pvt Ltd");
  const globex = company("Globex");

  it("exact normalized match scores highest", () => {
    expect(scoreCompany(acme, "acme corp")).toBe(3);
    expect(scoreCompany(acme, "acme")).toBe(3); // alias
    expect(scoreCompany(globex, "acme")).toBe(0);
  });
  it("prefix matches score 2", () => {
    expect(scoreCompany(acmeLabs, "acme")).toBe(2);
  });
  it("pickCandidates ranks and filters deterministically", () => {
    const rows = [globex, acmeLabs, acme];
    const ranked = pickCandidates(rows, "Acme");
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.name).toBe("Acme Corp"); // exact beats prefix
    expect(ranked[0]!.score).toBe(3);
    expect(ranked[1]!.name).toBe("Acme Labs Pvt Ltd");
  });
  it("empty query returns nothing", () => {
    expect(pickCandidates([acme], "  ")).toEqual([]);
    expect(pickCandidates([acme], "!!!")).toEqual([]);
  });
});
