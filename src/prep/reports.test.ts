// Report skeleton builder tests (pure) + source-level wiring checks for the
// report API and page.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildReportSkeleton } from "./report-skeleton";
import type { SourceDocument } from "./sources/types";
import type { GatheredSources } from "./sources/gather";
import type { PrepCompany } from "./schema";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const company: Pick<PrepCompany, "name" | "slug" | "domain" | "website" | "status"> = {
  name: "Acme Corp",
  slug: "acme-corp",
  domain: "acme.example",
  website: "https://acme.example",
  status: "ACTIVE",
};

const doc = (over: Partial<SourceDocument> & { url: string }): SourceDocument => ({
  title: "Doc",
  publisher: "Acme Corp",
  label: "OFFICIAL",
  fetchedAt: "2026-10-18T12:00:00.000Z",
  text: "text",
  ...over,
});

const gathered = (documents: SourceDocument[]): GatheredSources => ({
  documents,
  errors: [],
  adaptersRun: ["official", "news"],
});

describe("buildReportSkeleton", () => {
  it("carries company overview from the DB record, not scrapes", () => {
    const sk = buildReportSkeleton(company, gathered([]));
    expect(sk.overview).toEqual({
      name: "Acme Corp",
      slug: "acme-corp",
      domain: "acme.example",
      website: "https://acme.example",
      status: "ACTIVE",
    });
  });
  it("splits official docs into careers vs sites", () => {
    const sk = buildReportSkeleton(
      company,
      gathered([
        doc({ url: "https://acme.example/", title: "Acme Corp" }),
        doc({ url: "https://acme.example/careers", title: "Careers at Acme" }),
        doc({ url: "https://acme.example/jobs", title: "Open roles" }),
      ]),
    );
    expect(sk.careers.map((c) => c.url)).toEqual(["https://acme.example/careers", "https://acme.example/jobs"]);
    expect(sk.officialSites.map((c) => c.url)).toEqual(["https://acme.example/"]);
  });
  it("sorts recent news by publishedAt desc and labels NEWS", () => {
    const sk = buildReportSkeleton(
      company,
      gathered([
        doc({ url: "https://n.example/old", label: "NEWS", publishedAt: "2026-01-01T00:00:00.000Z" }),
        doc({ url: "https://n.example/new", label: "NEWS", publishedAt: "2026-10-01T00:00:00.000Z" }),
        doc({ url: "https://n.example/mid", label: "NEWS", publishedAt: "2026-06-01T00:00:00.000Z" }),
      ]),
    );
    expect(sk.recentNews.map((n) => n.url)).toEqual([
      "https://n.example/new",
      "https://n.example/mid",
      "https://n.example/old",
    ]);
    expect(sk.recentNews.every((n) => n.label === "NEWS")).toBe(true);
  });
  it("every section item traces to a provenance entry", () => {
    const docs = [
      doc({ url: "https://acme.example/" }),
      doc({ url: "https://acme.example/careers" }),
      doc({ url: "https://n.example/x", label: "NEWS" }),
    ];
    const sk = buildReportSkeleton(company, gathered(docs));
    const provUrls = new Set(sk.provenance.map((p) => p.url));
    for (const item of [...sk.careers, ...sk.officialSites, ...sk.recentNews]) {
      expect(provUrls.has(item.url!)).toBe(true);
    }
  });
  it("includes the legal disclaimers and counts sources", () => {
    const sk = buildReportSkeleton(company, gathered([doc({ url: "https://a.example/" })]));
    expect(sk.disclaimers.length).toBeGreaterThanOrEqual(3);
    expect(sk.sourceCount).toBe(1);
    expect(sk.disclaimers.join(" ")).toMatch(/not legal/i);
  });
  it("keeps role and user type when provided", () => {
    const sk = buildReportSkeleton(company, gathered([]), { role: "SDE-1", userType: "student" });
    expect(sk.role).toBe("SDE-1");
    expect(sk.userType).toBe("student");
  });
});

describe("report router wiring (source-level)", () => {
  const src = read("src/prep/router.ts");
  it("has authenticated POST /reports and GET report routes", () => {
    expect(src).toContain('prepRouter.post("/reports"');
    expect(src).toContain('prepRouter.get("/reports/:id"');
    expect(src).toContain('prepRouter.get("/companies/:slug/report"');
  });
  it("rate-limits report generation", () => {
    expect(src).toMatch(/reportLimiter/);
  });
});

describe("report page (source-level)", () => {
  const page = read("public/prep/report.html");
  it("is noindex and requires login", () => {
    expect(page).toContain('<meta name="robots" content="noindex"/>');
    expect(page).toContain('if (!localStorage.getItem("se_token"))');
  });
  it("escapes all dynamic content", () => {
    expect(page).toContain('function esc(s)');
    expect(page).toContain("esc(it.title)");
    expect(page).toContain("esc(p.publisher || p.title)");
  });
  it("opens source links with noopener and no referrer-following", () => {
    expect(page).toContain('rel="noopener noreferrer"');
  });
  it("fetches the slug-scoped report endpoint", () => {
    expect(page).toContain("/api/prep/companies/");
    expect(page).toContain("/report");
  });
});

describe("prep pages serve the report shell", () => {
  const src = read("src/prep/pages.ts");
  it("maps /prep/report/<slug> to report.html", () => {
    expect(src).toMatch(/\^report\\\/\[A-Za-z0-9_-\]\{1,160\}\$/);
    expect(src).toContain('path.join(prepRoot, "report.html")');
  });
});
