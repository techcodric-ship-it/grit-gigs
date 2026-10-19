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

describe("nav stability: flash, wallet, avatar on prep pages", () => {
  const nav = read("public/js/prep-nav.js");
  it("injects the Prep icon from the prep_nav cookie BEFORE any fetch (no 2s flash)", () => {
    expect(nav).toContain('if (cookieEnabled()) inject(true);');
    expect(nav).toContain("prep_nav=1");
    expect(nav.indexOf("if (cookieEnabled()) inject(true);")).toBeLessThan(
      nav.indexOf('fetch("/api/prep/flag"'),
    );
    expect(nav).toContain("document.cookie = \"prep_nav=; Max-Age=0; Path=/\";"); // flag-off clears it
  });
  it("the server ships the cookie with every page response", () => {
    const app = read("src/app.ts");
    expect(app).toContain('res.cookie("prep_nav", "1"');
    expect(app).toContain('res.clearCookie("prep_nav"');
    expect(app).toContain("if (isPrepEnabled())");
    // must run before static serving so HTML responses carry it
    expect(app.indexOf('res.cookie("prep_nav"')).toBeLessThan(app.indexOf("express.static(publicPath)"));
  });
  it("wallet icon is injected on prep pages (feed-app.js is not loaded there)", () => {
    expect(nav).toContain('a[href="/wallet.html"]');
    expect(nav).toContain('w.title = "Wallet"');
    expect(nav).toContain("row.insertBefore(w, anchor)");
  });
  it("nav avatar comes from the cached session, refreshed via /api/auth/me", () => {
    expect(nav).toContain('document.getElementById("navAv")');
    expect(nav).toContain('localStorage.getItem("se_user")');
    expect(nav).toContain("profilePhoto");
    expect(nav).toContain('fetch("/api/auth/me"');
    expect(nav).toContain("d.data.user");
  });
});

describe("Prep Pro is pay-only (Razorpay order + verify)", () => {
  const router = read("src/prep/router.ts");
  const dbLayer = read("src/prep/monetization-db.ts");
  const home = read("public/prep/index.html");
  it("router exposes order/verify and nothing that activates on click", () => {
    expect(router).toContain('prepRouter.post("/pro/order"');
    expect(router).toContain('prepRouter.post("/pro/verify"');
    expect(router).not.toContain('prepRouter.post("/pro/purchase"');
    expect(dbLayer).not.toContain("purchasePro");
    expect(dbLayer).not.toContain("paymentMethod: \"wallet\"");
  });
  it("home page drives the checkout modal, not the old purchase call", () => {
    expect(home).toContain("/api/prep/pro/order");
    expect(home).toContain("/api/prep/pro/verify");
    expect(home).not.toContain("/api/prep/pro/purchase");
    expect(home).toContain("new Razorpay({");
    expect(home).toContain("order_id: order.id");
    expect(home).toContain("Payment cancelled. You were not charged.");
  });
  it("verify checks captured + order + amount before calling completeProOrder", () => {
    const verifyIdx = router.indexOf('prepRouter.post("/pro/verify"');
    const capturedIdx = router.indexOf('payment.status !== "captured"', verifyIdx);
    const amountIdx = router.indexOf("payment.amount !== Math.round(amtInr * 100)", verifyIdx);
    const completeIdx = router.indexOf("completeProOrder(", verifyIdx);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(capturedIdx).toBeGreaterThan(verifyIdx);
    expect(amountIdx).toBeGreaterThan(capturedIdx);
    expect(completeIdx).toBeGreaterThan(amountIdx); // grant strictly after all checks
  });
});

describe("design: product-grade presentation", () => {
  const home = read("public/prep/index.html");
  const css = read("public/prep/prep.css");
  it("hero has CTAs, stats and a grid backdrop", () => {
    expect(home).toContain('class="prep-hero-ctas"');
    expect(home).toContain('href="#prepSearchForm"');
    expect(home).toContain('id="prepFeatures"');
    expect(home).toContain('class="prep-stats prep-hero-stats"');
    expect(home).toContain("<b>55</b>");
    expect(css).toContain("background-size: 34px 34px");
    expect(css).toContain("background-clip: text");
  });
  it("feature cards use real SVG icons in gradient tiles", () => {
    expect(home).toMatch(/class="prep-feature-k"><svg viewBox="0 0 24 24"/);
    expect(home).not.toMatch(/class="prep-feature-k">C[RA]<\//); // letter tiles are gone
    expect(css).toContain(".prep-feature-k svg");
    expect(css).toContain("linear-gradient(135deg, var(--prep-violet)");
  });
  it("steps are numbered, buttons are gradient, Pro card is premium", () => {
    expect(css).toContain("counter-reset: prep-step");
    expect(css).toContain("scroll-margin-top: 76px"); // anchors clear the fixed nav
    expect(home).toContain('class="prep-card prep-card-pro"');
    expect(home).toContain('class="prep-pro-badge"');
    expect(home).toContain('class="prep-foot-brand"');
    expect(css).toContain(".prep-card-pro");
  });
});

describe("search never dead-ends (fresh database proof)", () => {
  const router = read("src/prep/router.ts");
  it("empty DB search synthesizes the typed company as a NEW candidate", () => {
    expect(router).toContain("if (!matches.length)");
    expect(router).toContain("slugifyCompanyName(typed)");
    expect(router).toContain('status: "NEW"');
    expect(router).not.toContain("needsCreation: matches.length === 0");
  });
  it("opening a not-yet-known company provisions a PENDING row and its report", () => {
    expect(router).toContain('req.query.name');
    expect(router).toContain("nameParam.length >= 2");
    expect(router).toContain("resolveCompany(db, nameParam)");
    expect(router).toContain("createPendingCompany(db, { name: nameParam");
    // provision sits BEFORE the quota/gather steps so the report actually runs
    const routeIdx = router.indexOf('prepRouter.get("/companies/:slug/report"');
    expect(router.indexOf("createPendingCompany(db, { name: nameParam", routeIdx)).toBeGreaterThan(routeIdx);
    expect(router.indexOf("createPendingCompany(db, { name: nameParam")).toBeLessThan(router.indexOf("gatherSources({", routeIdx));
  });
  it("home search passes the typed name and labels virtual candidates", () => {
    const home = read("public/prep/index.html");
    expect(home).toContain('&name=" + encodeURIComponent(m.name)');
    expect(home).toContain('m.status === "NEW"');
    expect(home).toContain("Start report");
  });
  it("flag probe reports payment-gateway readiness as a boolean only", () => {
    expect(router).toContain("paymentsConfigured: razorpayConfigured()");
    expect(router).toContain("paymentsConfigured: razorpayConfigured() } });");
  });
});

describe("Prep Pro card earns trust before payment", () => {
  const home = read("public/prep/index.html");
  const css = read("public/prep/prep.css");
  it("leads with price, one-time framing and truthful perks", () => {
    expect(home).toContain('class="prep-pro-price-row"');
    expect(home).toContain("\u20b9199");
    expect(home).toContain("No auto-renewal");
    expect(home).toContain('class="prep-pro-perks"');
    expect(home).toContain("free plan allows 3 a day");
    expect(home).toContain("No subscription, nothing auto-renews");
    expect(css).toContain(".prep-pro-perks li::before");
    expect(css).toContain(".prep-pro-price");
  });
  it("shows the Razorpay security note", () => {
    expect(home).toContain('class="prep-pay-trust"');
    expect(home).toContain("Secured by Razorpay");
    expect(home).toContain("never store your card details");
    expect(css).toContain(".prep-pay-trust");
  });
  it("every click path gives visible feedback (never looks dead)", () => {
    expect(home).toContain("Opening secure checkout");
    expect(home).toContain('function proInfo(');
    expect(home).toContain('function proFail(');
    expect(home).toContain('proErr.className = "prep-err info"');
    expect(css).toContain(".prep-err.info");
    expect(home).toContain("Could not load the payment gateway");
    expect(home).toContain("Payment cancelled. You were not charged.");
    // a blocked/faulty checkout script must surface, not throw silently
    expect(home).toContain("function go() { try { onReady(); } catch (e) { onFail(e); } }");
  });
});

describe("feed rail leads with the Prep feature card", () => {
  const nav = read("public/js/prep-nav.js");
  it("promo is injected FIRST in the sidebar, flag-gated, idempotent", () => {
    expect(nav).toContain('document.querySelector(".sidebar")');
    expect(nav).toContain('setAttribute("data-prep-promo"');
    expect(nav).toContain("side.insertBefore(p, side.firstElementChild)");
    expect(nav).toContain('side.querySelector("[data-prep-promo]")');
    expect(nav).toContain("function removePromo()");
    expect(nav).toContain('a.href = "/prep"');
    expect(nav).toContain("New - Prep");
  });
  it("promo and icon are removed together when the flag turns off", () => {
    const offIdx = nav.indexOf("if (!enabled) {");
    expect(offIdx).toBeGreaterThan(-1);
    expect(nav.indexOf("removePromo()", offIdx)).toBeLessThan(nav.indexOf('document.cookie = "prep_nav=; Max-Age=0; Path=/";', offIdx));
  });
});

describe("stale links and stalls can never dead-end (round 4)", () => {
  const router = read("src/prep/router.ts");
  it("report route self-heals old links: derives the company name from the slug", () => {
    const routeIdx = router.indexOf('prepRouter.get("/companies/:slug/report"');
    expect(routeIdx).toBeGreaterThan(-1);
    expect(router.indexOf('req.params.slug).replace(/[-_]+/g, " ")', routeIdx)).toBeGreaterThan(routeIdx);
    expect(router.indexOf("queryName.length >= 2", routeIdx)).toBeGreaterThan(routeIdx);
    // fallback only enriches the missing name, it never precedes the query param
    expect(router.indexOf("queryName.length >= 2")).toBeLessThan(
      router.indexOf('req.params.slug).replace(/[-_]+/g, " ")'),
    );
  });
  it("razorpay calls carry a 15s hard timeout (no hostage button)", () => {
    expect(router.split("AbortSignal.timeout(15000)").length - 1).toBeGreaterThanOrEqual(2);
    expect(router).toContain('timedOut ? "Payment gateway timed out. Please try again."');
  });
  it("prep HTML is revalidated on every load (stale page cannot replay old flows)", () => {
    const pages = read("src/prep/pages.ts");
    expect(pages.split('res.set("Cache-Control", "no-cache")').length - 1).toBe(2);
  });
  it("client watchdog + modal visibility cover every silent-stall path", () => {
    const home = read("public/prep/index.html");
    expect(home).toContain("new AbortController()");
    expect(home).toContain("}, 12000);");
    expect(home).toContain('e.name === "AbortError"');
    expect(home).toContain("The payment service is taking too long. Please try again.");
    expect(home).toContain('rz.on("ready"');
    expect(home).toContain("}, 7000);");
    expect(home).toContain("Disable ad blockers for this site");
    expect(home).toContain('proInfo("Payment window opening...")');
    expect(home).toContain("modalReady");
    expect(home).toContain("modalClosed");
  });
  it("deploy logs payment-gateway reachability without leaking secrets", () => {
    const yml = read(".github/workflows/deploy.yml");
    expect(yml).toContain("rz-egress:");
    expect(yml).toContain("https://api.razorpay.com/v1/orders");
    expect(yml).not.toMatch(/RAZORPAY_KEY_SECRET/); // creds live server-side only
  });
});

describe("report page forwards its query string (round 4)", () => {
  it("report.html passes location.search so name= provisions the company", () => {
    const rp = read("public/prep/report.html");
    expect(rp).toContain('var qs = location.search || (role ? "?role=" + encodeURIComponent(role) : "");');
    expect(rp).toContain('"/report" + qs');
  });
});
