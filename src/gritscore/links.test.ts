import { describe, expect, it } from "vitest";
import { normalisePortfolioLinks, publicLinks } from "./links";

describe("normalisePortfolioLinks", () => {
  it("keeps only http(s) URLs, dedupes and caps the list", () => {
    const links = normalisePortfolioLinks([
      " https://github.com/techcodric-ship-it ",
      "https://GITHUB.com/techcodric-ship-it/",
      "javascript:alert(1)",
      "",
      "https://portfolio.dev",
    ]);
    expect(links).toEqual(["https://github.com/techcodric-ship-it", "https://portfolio.dev"]);
  });

  it("accepts a single URL and trims it to the stored length cap", () => {
    const long = "https://example.com/" + "a".repeat(700);
    expect(normalisePortfolioLinks(long)[0]).toHaveLength(600);
  });

  it("turns a bare portfolio domain into an https link", () => {
    expect(normalisePortfolioLinks(["github.com/techcodric-ship-it"])).toEqual([
      "https://github.com/techcodric-ship-it",
    ]);
    expect(normalisePortfolioLinks(["javascript:alert(1)"])).toEqual([]);
  });
});

describe("publicLinks", () => {
  const item = { proofUrl: "https://github.com/techcodric-ship-it" };

  it("shows owner-submitted links and never derives Links from item proof", () => {
    const links = publicLinks(
      {
        portfolioLinks: ["https://www.myportfolio.dev"],
        extracted: { links: ["https://github.com/techcodric-ship-it", "https://resume-site.dev"] },
      },
      [item],
    );
    expect(links.map((l) => l.url)).toEqual(["https://www.myportfolio.dev", "https://resume-site.dev"]);
  });

  it("still shows a link when the owner submits it explicitly", () => {
    const links = publicLinks(
      {
        portfolioLinks: ["https://github.com/techcodric-ship-it"],
        extracted: { links: ["https://github.com/techcodric-ship-it"] },
      },
      [item],
    );
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://github.com/techcodric-ship-it");
    expect(links[0].label).toBeTruthy();
  });

  it("dedupes and caps at eight links", () => {
    const links = publicLinks(
      {
        portfolioLinks: Array.from({ length: 10 }, (_, i) => `https://site${i}.dev`),
        extracted: { links: [] },
      },
      [],
    );
    expect(links).toHaveLength(8);
  });
});
