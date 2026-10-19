// UX polish regressions (round: nav order, stylesheet basis, professional
// content, Gemini provider, secret hygiene).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const PREP_PAGES = [
  "public/prep/index.html",
  "public/prep/report.html",
  "public/prep/aptitude.html",
  "public/prep/interview.html",
  "public/prep/proof.html",
];

function iconsBlock(html: string): string {
  const i = html.indexOf('<div class="icons">');
  if (i === -1) return "";
  return html.slice(i, html.indexOf("</div>", i));
}

describe("nav: Prep leads the icon row", () => {
  for (const page of PREP_PAGES) {
    it(`${page} puts /prep first, before Home`, () => {
      const block = iconsBlock(read(page));
      expect(block).not.toBe("");
      const first = block.match(/<a\s[^>]*href="([^"]+)"/);
      expect(first?.[1]).toBe("/prep");
    });
  }
  it("prep-nav.js injects the icon FIRST on the flag-gated pages", () => {
    const src = read("public/js/prep-nav.js");
    expect(src).toContain("var first = row.firstElementChild;");
    expect(src).toContain("row.insertBefore(a, first)");
  });
  it("every icon-nav page cache-busts the injected script", () => {
    for (const p of [
      "public/feed.html",
      "public/explore.html",
      "public/profile.html",
      "public/settings.html",
      "public/wallet.html",
      "public/orders.html",
      "public/messages.html",
      "public/notifications.html",
      "public/buy-more.html",
    ]) {
      expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
    }
  });
});

describe("styles: prep pages sit on feed.css, not the legacy main.css", () => {
  for (const page of PREP_PAGES) {
    it(`${page} links feed.css and drops main.css`, () => {
      const html = read(page);
      expect(html).toContain('<link rel="stylesheet" href="/assets/feed.css?v=36"/>');
      expect(html).not.toContain("css/main.css");
      expect(html).toMatch(/prep\/prep\.css\?v=\d+/);
    });
  }
  it("prep.css clears the fixed 52px topnav and defines the new sections", () => {
    const css = read("public/prep/prep.css");
    expect(css).toMatch(/\.prep-wrap \{[^}]*padding:\s*76px/);
    expect(css).toContain(".prep-hero");
    expect(css).toContain(".prep-feature-grid");
    expect(css).toContain(".prep-stats");
    expect(css).toContain(".prep-foot");
  });
});

describe("content: home page reads like a product", () => {
  const home = read("public/prep/index.html");
  it("has a hero with positioning and trust chips", () => {
    expect(home).toContain('class="prep-eyebrow"');
    expect(home).toContain("Company research you can trust");
    expect(home).toContain("No Glassdoor / LinkedIn scraping");
    expect(home).toContain("Aggregates unlock at 5 reports");
  });
  it("documents all four feature areas", () => {
    for (const t of ["Company reports", "Aptitude practice", "Interview prep", "Trust checks"]) {
      expect(home, t).toContain(`<b>${t}</b>`);
    }
    expect(home).toContain("31 original questions");
    expect(home).toContain("24 questions across behavioural, technical and HR rounds");
    expect(home).toContain("at least 5 approved reports");
  });
  it("explains the flow and closes with an honest disclaimer", () => {
    expect(home).toContain("How it works");
    expect(home).toContain('class="prep-foot"');
    expect(home).toContain("not legal or financial advice");
    expect(home).toContain("individuals are never exposed");
  });
  it("keeps every functional hook the scripts and tests depend on", () => {
    for (const id of [
      "prepSearchForm",
      "prepCompany",
      "prepSearchBtn",
      "prepMatches",
      "prepProCard",
      "prepProBuy",
      "prepRecent",
    ]) {
      expect(home, id).toContain(`id="${id}"`);
    }
    expect(home).toContain("Buy Prep Pro — ₹199 / 30 days");
  });
});

describe("content: inner pages carry stats and legends", () => {
  it("report explains how to read source chips", () => {
    const r = read("public/prep/report.html");
    expect(r).toContain("How to read this report");
    expect(r).toContain("OFFICIAL");
    expect(r).toContain("AI_ESTIMATE");
    expect(r).toContain("individual submissions are never shown");
  });
  it("aptitude shows its bank size", () => {
    const a = read("public/prep/aptitude.html");
    expect(a).toContain('class="prep-stats"');
    expect(a).toContain("<b>31</b>");
    expect(a).toContain("quant, logical, verbal");
  });
  it("interview shows tracks and feedback promise", () => {
    const i = read("public/prep/interview.html");
    expect(i).toContain("<b>24</b>");
    expect(i).toContain("Behavioural · Technical · HR");
    expect(i).toContain("weakest category");
  });
  it("proof shows the 3-step flow and anonymity promise", () => {
    const p = read("public/prep/proof.html");
    expect(p).toContain("<b>1 · Submit</b>");
    expect(p).toContain("<b>3 · Unlocks</b>");
    expect(p).toContain("You are never identified");
  });
});

describe("Gemini provider (replaces Groq for Prep)", () => {
  const ai = read("src/prep/ai.ts");
  it("targets the Gemini generateContent endpoint with the key header", () => {
    expect(ai).toContain("GEMINI_API_KEY");
    expect(ai).toContain("generativelanguage.googleapis.com");
    expect(ai).toContain("x-goog-api-key");
    expect(ai).toContain(":generateContent");
    expect(ai).toContain("systemInstruction");
    expect(ai).toContain('process.env.GEMINI_MODEL || "gemini-3.8-flash"');
  });
  it("has no Groq references left in Prep", () => {
    expect(ai).not.toContain("groq");
    expect(ai).not.toContain("GROQ");
    expect(read("src/prep/ai.test.ts")).not.toContain("GROQ");
    expect(read("src/prep/ai.test.ts")).toContain("GEMINI_API_KEY");
  });
  it("still enforces grounding rules on top of the new provider", () => {
    expect(ai).toContain("STRICT JSON");
    expect(ai).toContain("citation");
    expect(ai).not.toContain("groq.com");
  });
});

describe("secret hygiene", () => {
  const files = [
    ".github/workflows/deploy.yml",
    ".env.example",
    "src/prep/ai.ts",
    "README.md",
    "docs/prep-audit.md",
  ];
  it("deploy pulls the key from the repo secret, never a literal", () => {
    const yml = read(".github/workflows/deploy.yml");
    expect(yml).toContain("${{ secrets.GEMINI_API_KEY }}");
    expect(yml).toContain("value masked");
  });
  it("no committed file assigns a real GEMINI_API_KEY value", () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/^GEMINI_API_KEY=.+/m);
    }
    expect(read(".env.example")).toMatch(/^# GEMINI_API_KEY=/m);
  });
});
