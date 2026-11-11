import { describe, expect, it } from "vitest";
import { renderScoreShell, type ShellCard } from "./shell";

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="robots" content="index, follow"/>
<title>Proof Score - Grit&amp;Gigs</title>
<meta property="og:title" content="Proof Score - Grit&amp;Gigs"/>
<meta property="og:description" content="A shareable Proof Score."/>
<meta property="og:image" content="https://www.gritandgigs.in/og-default.png"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="canonical" href="https://www.gritandgigs.in/score"/>
</head>
<body></body>
</html>`;

const CARD: ShellCard = {
  slug: "asha-rao-4f2a1c",
  displayName: "Asha Rao",
  tier: "Elite",
  summary: "Backend engineer with shipped billing work.",
  verificationTier: "evidence_checked",
  skills: ["Node.js", "PostgreSQL", "Billing"],
};

describe("renderScoreShell", () => {
  it("injects per-card OG tags for a public card", () => {
    const html = renderScoreShell(SHELL, { origin: "https://www.gritandgigs.in", slug: CARD.slug, card: CARD });
    expect(html).toContain('<meta property="og:title" content="Asha Rao - Elite Proof Score"/>');
    expect(html).toContain('<meta property="og:url" content="https://www.gritandgigs.in/score/asha-rao-4f2a1c"/>');
    expect(html).toContain(
      '<meta property="og:image" content="https://www.gritandgigs.in/api/gritscore/public/asha-rao-4f2a1c/card.png"/>',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
    expect(html).toContain("<title>Asha Rao - Elite Proof Score</title>");
    expect(html).toContain('<link rel="canonical" href="https://www.gritandgigs.in/score/asha-rao-4f2a1c"/>');
    expect(html).toContain('<meta name="robots" content="index, follow"/>');
  });

  it("keeps the generated card PNG instead of the generic site image", () => {
    const html = renderScoreShell(SHELL, { origin: "https://www.gritandgigs.in", slug: CARD.slug, card: CARD });
    expect(html).not.toContain("og-default.png");
  });

  it("marks missing and private cards noindex and keeps the real slug", () => {
    const html = renderScoreShell(SHELL, { origin: "https://www.gritandgigs.in", slug: "deleted-card", card: null });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain('<link rel="canonical" href="https://www.gritandgigs.in/score/deleted-card"/>');
    expect(html).toContain('<meta property="og:url" content="https://www.gritandgigs.in/score/deleted-card"/>');
    // The shell title must not claim a specific person.
    expect(html).toContain("<title>Proof Score - Grit&amp;Gigs</title>");
  });

  it("escapes card text so a name cannot break the meta tags", () => {
    const html = renderScoreShell(SHELL, {
      origin: "https://www.gritandgigs.in",
      slug: "x-card-1",
      card: { ...CARD, displayName: 'Asha "Ace" <script>', summary: 'quote " and <tag>' },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;Ace&quot;");
    expect(html).toContain('content="quote &quot; and &lt;tag&gt;"');
  });

  it("uses the first five skills only", () => {
    const html = renderScoreShell(SHELL, {
      origin: "https://www.gritandgigs.in",
      slug: "skills-card",
      card: { ...CARD, summary: null, skills: ["a", "b", "c", "d", "e", "f", "g"] },
    });
    expect(html).toContain("covering a, b, c, d, e.");
    expect(html).not.toContain("covering a, b, c, d, e, f");
  });

  it("falls back to the verification label when there is no summary", () => {
    const html = renderScoreShell(SHELL, {
      origin: "https://www.gritandgigs.in",
      slug: "no-summary",
      card: { ...CARD, summary: null, skills: [] },
    });
    expect(html).toContain("Evidence checked proof summary.");
  });
});
