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
    expect(home).toContain("Company packs of questions candidates were actually asked");
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
  it("interview shows company packs and the AI scoring promise", () => {
    const i = read("public/prep/interview.html");
    expect(i).toContain('class="prep-trust-chips"');
    expect(i).toContain("Company packs &middot; member-reported");
    expect(i).toContain("Mock: AI scores every answer");
    expect(i).toContain("Weakest area");
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
    expect(nav).toContain('seFetch("/api/auth/me"');
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
    expect(home).toContain('<b id="statQuestions">55</b>');
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
    expect(router.indexOf("createPendingCompany(db, { name: nameParam")).toBeLessThan(router.indexOf("gatherSourcesWithBudget(", routeIdx));
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

describe("the Buy button can never look dead; members look like members (round 5)", () => {
  const home = read("public/prep/index.html");
  const nav = read("public/js/prep-nav.js");
  const css = read("public/prep/prep.css");
  it("stale prep HTML is detected by the always-fresh nav script and re-fetched exactly once", () => {
    expect(nav).toContain("var WANT_V = 15;");
    expect(nav).toContain("window.PREP_V !== WANT_V");
    expect(nav).toContain('!/[?&]_pv=/.test(location.search)');
    expect(nav).toContain("location.replace(location.pathname + location.search +");
    for (const p of [
      "public/prep/index.html",
      "public/prep/report.html",
      "public/prep/aptitude.html",
      "public/prep/interview.html",
      "public/prep/proof.html",
    ]) {
      expect(read(p), p).toContain("window.PREP_V = 15;");
      expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
    }
  });
  it("every click path labels the button itself and nothing reloads the page", () => {
    expect(home).toContain("e.preventDefault();");
    expect(home).toContain('proBuy.textContent = "Opening secure checkout...";');
    expect(home).toContain("function proReset()");
    expect(home).toContain("var BUY_LABEL = proBuy.textContent;");
    expect(home).not.toContain("window.location.reload()");
    expect(home).toContain("if (res.status === 401) { sessionExpiredPro(); return; }");
    expect(home).toContain("if (v.status === 401) { sessionExpiredPro(); return; }");
    expect(home).toContain("function sessionExpiredPro()");
    expect(home).toContain('location.replace("/login?next="');
  });
  it("a confirmed entitlement renders the professional member panel in place", () => {
    expect(home).toContain("showActiveNow(");
    expect(home).toContain("function showActiveNow(expiresAt)");
    expect(home).toContain("You\u2019re Prep Pro"); // in-file escape, no raw unicode in tests
    expect(home).toContain("prep-pro-tick");
    expect(home).toContain("prep-pro-live");
    expect(home).toContain("prep-pro-until");
    expect(home).toContain("Enjoy unlimited reports");
    expect(home).toContain('card.classList.add("is-active")');
    expect(css).toContain(".prep-card-pro.is-active");
    expect(css).toContain(".prep-pro-on");
    expect(css).toContain(".prep-pro-tick");
    expect(css).toContain(".prep-pro-live li::before");
  });
  it("the logged-out card hides the Buy button instead of leaving a dead target", () => {
    const idx = home.indexOf("function showLoggedOutPro()");
    expect(idx).toBeGreaterThan(-1);
    expect(home.indexOf("proBuy.hidden = true;", idx)).toBeLessThan(
      home.indexOf("function showPro(d)", idx),
    );
  });
  it("the wallet is never debited: copy says so and no wallet route exists client-side", () => {
    expect(home).toContain("wallet balance is never used");
    expect(home).not.toContain("/api/prep/pro/purchase");
    expect(home).not.toContain("insufficient-balance");
  });
  it("the nav shows a PRO chip from a cached verdict, refreshed at most every 5 minutes", () => {
    expect(nav).toContain("data-prep-pro-chip");
    expect(nav).toContain('chip.textContent = "PRO"');
    expect(nav).toContain("5 * 60 * 1000");
    expect(nav).toContain("/api/prep/pro/status");
    expect(nav).toContain("verdict.pro === true");
    expect(home).toContain("JSON.stringify({ v: 1, ts: Date.now(), pro: true })");
    expect(home).toContain("JSON.stringify({ v: 1, ts: Date.now(), pro: false })");
  });
});

describe("reports always render: bounded gathering, honest progress (round 6)", () => {
  const router = read("src/prep/router.ts");
  const official = read("src/prep/sources/official.ts");
  const news = read("src/prep/sources/news.ts");
  const urls = read("src/prep/sources/urls.ts");
  const gather = read("src/prep/sources/gather.ts");
  const ai = read("src/prep/ai.ts");
  const rp = read("public/prep/report.html");
  it("every report path races gathering against a 12s hard budget", () => {
    expect(router).toContain("gatherSourcesWithBudget(");
    expect(router).not.toMatch(/await gatherSources\(/);
    expect(router.split("12_000").length - 1).toBeGreaterThanOrEqual(2); // POST + GET
    expect(gather).toContain("gatherSourcesWithBudget");
    expect(gather).toContain("gather:budget-exceeded");
  });
  it("the official adapter fetches robots once per origin and keeps a wall-clock budget", () => {
    expect(official).toContain("OFFICIAL_BUDGET_MS = 8000");
    expect(official).toContain("official:time-budget");
    expect(official.split("fetchRobots(").length - 1).toBe(1); // hoisted out of the path loop
    // no per-path DNS re-check of an already validated origin
    expect(official.indexOf("for (const path of CAREERS_PATHS)")).toBeGreaterThan(
      official.indexOf("const robots = await fetchRobots"),
    );
  });
  it("the news adapter checks items in parallel under its own budget", () => {
    expect(news).toContain("NEWS_BUDGET_MS = 8000");
    expect(news).toContain("Promise.all(");
  });
  it("DNS lookups cannot hang a report (3s cap)", () => {
    expect(urls).toContain("DNS_TIMEOUT_MS = 3000");
    expect(urls).toContain("dns-timeout");
  });
  it("the AI summary is capped so it can never stall the page", () => {
    expect(ai).toContain("AI_TIMEOUT_MS = 12_000");
  });
  it("the report page explains the wait and gives up gracefully", () => {
    expect(rp).toContain("Gathering official pages and recent news");
    expect(rp).toContain("}, 2500);");
    expect(rp).toContain("}, 40000);");
    expect(rp).toContain('e.name === "AbortError"');
    expect(rp).toContain("Refresh the page to retry.");
    expect(rp).toContain("signal: ctl ? ctl.signal : undefined");
  });
});

describe("first load works, modules are reachable, history is real (round 7)", () => {
  const home = read("public/prep/index.html");
  const rp = read("public/prep/report.html");
  const css = read("public/prep/prep.css");
  const router = read("src/prep/router.ts");
  const reports = read("src/prep/reports.ts");
  it("a freshly generated report (201) renders instead of erroring", () => {
    expect(rp).toContain("(res.status !== 200 && res.status !== 201) || !res.d.success");
    expect(router).toContain('res.status(201).json({ success: true, data: { report: publicReport(report), cached: false } });');
  });
  it("every prep page carries the module tabs with the correct active pill", () => {
    const pages = [
      ["public/prep/index.html", "reports"],
      ["public/prep/report.html", "reports"],
      ["public/prep/aptitude.html", "aptitude"],
      ["public/prep/interview.html", "interview"],
      ["public/prep/proof.html", "proof"],
    ];
    for (const p of pages) {
      const html = read(p[0]);
      expect(html, p[0]).toContain('class="prep-tabs"');
      expect(html, p[0]).toContain('href="/prep/interview"');
      expect(html, p[0]).toContain('href="/prep/aptitude"');
      const onHref = p[1] === "reports" ? "/prep" : "/prep/" + p[1];
      expect(html, p[0]).toContain('class="prep-tab on" href="' + onHref + '"');
    }
    expect(css).toContain(".prep-tabs");
    expect(css).toContain(".prep-tab.on");
  });
  it("feature tiles link to the module they describe", () => {
    expect(home).toContain('<a class="prep-feature" href="#prepSearchForm">');
    expect(home).toContain('<a class="prep-feature" href="/prep/aptitude">');
    expect(home).toContain('<a class="prep-feature" href="/prep/interview">');
    expect(home).toContain('<a class="prep-feature" href="/prep/proof">');
    expect(home).not.toContain('<div class="prep-feature">');
    expect(css).toContain("a.prep-feature:hover");
  });
  it("an empty report swaps the confusing legend for an honest explanation", () => {
    expect(rp).toContain('id="rpLegend"');
    expect(rp).toContain('id="rpEmptyCard"');
    expect(rp).toContain("No public sources found yet");
    expect(rp).toContain('id="rpEmptyName"');
    expect(rp).toContain('document.getElementById("rpLegend").hidden = true');
    expect(rp).toContain('document.getElementById("rpEmptyCard").hidden = false');
    expect(rp).toContain('href="/prep/aptitude">Aptitude practice</a>');
  });
  it("Recent reports lists the user's own history from the server", () => {
    expect(router).toContain('prepRouter.get("/my/reports"');
    expect(router).toContain("listRecentReportsForUser(req.user!.id, 10)");
    expect(reports).toContain("export async function listRecentReportsForUser");
    expect(reports).toContain("innerJoin(prepCompaniesTable");
    expect(reports).toContain("eq(prepReportsTable.createdBy, userId)");
    expect(home).toContain("/api/prep/my/reports");
    expect(home).toContain('id="prepRecent"');
  });
});

describe("messaging is open to everyone and presence is live (round 8)", () => {
  const profile = read("public/profile.html");
  const msgs = read("public/assets/messages.js");
  const msgsHtml = read("public/messages.html");
  const socketSrc = read("src/lib/socket.ts");
  it("every profile shows the Message button - no connection gate", () => {
    expect(profile).not.toContain("/community/connected/");
    expect(profile).toContain("location.href = '/messages.html?to='");
    expect(profile).toContain('id="pOnline"');
    expect(profile).toContain(".ponline{display:none");
    expect(profile).toContain("/messages/online-users");
    expect(profile).toContain("window.__pOnlinePoll");
    expect(profile).toContain("setInterval(paintPresence, 20000)");
  });
  it("the chat client shows typing and online/offline, refreshed continuously", () => {
    expect(msgs).toContain("socket.emit('typing'");
    expect(msgs).toContain("socket.on('typing'");
    expect(msgs).toContain("socket.on('user:online'");
    expect(msgs).toContain("socket.on('user:offline'");
    expect(msgs).toContain("' is typing'");
    expect(msgs).toContain("window.__ggnOnlinePoll");
    expect(msgsHtml).toContain("messages.js?v=");
  });
  it("the server side of presence/typing exists and stays read-only here", () => {
    expect(socketSrc).toContain('socket.on("typing"');
    expect(socketSrc).toContain('"user:online"');
    expect(socketSrc).toContain('"user:offline"');
  });
});

describe("a member never loses badges to a flaky status call (round 8)", () => {
  const nav = read("public/js/prep-nav.js");
  const home = read("public/prep/index.html");
  const router = read("src/prep/router.ts");
  it("the nav chip survives rate limits and only clears on a real 401", () => {
    expect(nav).toContain("if (!r.ok) return null;");
    expect(nav).toContain('if (r.status === 401) {');
    expect(nav).toContain('localStorage.removeItem("se_pro")');
    expect(nav).toContain("keep whatever is painted");
  });
  it("the home panel paints instantly from the cached plan and replays it on failure", () => {
    expect(home).toContain("localStorage.setItem(\"se_pro_last\"");
    expect(home).toContain("function replayCachedPro()");
    expect(home).toContain("proLast.d.isPro");
    expect(home).toContain("30 * 60 * 1000");
    expect(home).toContain('localStorage.removeItem("se_pro_last")');
    expect(home).toContain("Could not load Prep Pro status.");
    expect(home).not.toContain("window.location.reload()");
  });
  it("status reads get headroom so refreshes rarely even hit the limiter", () => {
    expect(router).toMatch(/const proLimiter = rateLimit\(\{\s*windowMs: 60 \* 1000,\s*max: 30,/);
  });
});

describe("AI company + role plans on aptitude & interview (round 9)", () => {
  const router = read("src/prep/router.ts");
  const ai = read("src/prep/ai.ts");
  const plans = read("src/prep/ai-plans.ts");
  const schema = read("src/prep/schema.ts");
  const db = read("src/prep/db.ts");
  const apt = read("public/prep/aptitude.html");
  const iv = read("public/prep/interview.html");
  const css = read("public/prep/prep.css");
  it("POST /ai/plan resolves the company, reuses cache, gates the free tier", () => {
    expect(router).toContain('prepRouter.post("/ai/plan", authenticate, aiPlanLimiter, prepDbGate');
    expect(router).toContain("const FREE_AI_PLANS_PER_DAY = 5;");
    expect(router).toContain("getCachedAiPlan(company.id, roleKey)");
    expect(router).toContain("countAiPlanRequestsToday(req.user!.id)");
    expect(router).toContain("recordAiPlanRequest(req.user!.id)");
    expect(router).toContain("gatherSourcesWithBudget(");
    expect(router).toContain("generatePrepPlan(");
    expect(router).toContain("fallbackPlan(company.name, role)");
    // The free allowance never dead-ends a search: capped/failing research
    // still answers with the role-tuned starter plan (limited: true).
    expect(router).not.toMatch(/status\(402\)[\s\S]{0,200}Free AI plans reset daily/);
    expect(router).not.toContain('"AI plan generation failed"');
    expect(router).toContain("limited: true");
    expect(router).not.toContain("gatherSources(");
  });
  it("the plan is grounded like a report and degrades honestly", () => {
    expect(ai).toContain("PLAN_SYSTEM_PROMPT");
    expect(ai).toContain("STRICT JSON");
    expect(ai).toContain("export function parsePlanResponse");
    expect(ai).toContain("export function fallbackPlan");
    expect(ai).toContain("export async function generatePrepPlan");
    expect(ai).toContain('grounded: false');
    expect(ai).toContain("maxOutputTokens = 700");
    expect(ai).toContain("1600");
  });
  it("plans persist per company+role with a 30-minute freshness window", () => {
    expect(plans).toContain("PLAN_CACHE_TTL_MS = 30 * 60 * 1000");
    expect(plans).toContain("onConflictDoUpdate");
    expect(plans).toContain("countAiPlanRequestsToday");
    expect(schema).toContain('pgTable("prep_ai_plans"');
    expect(schema).toContain('pgTable("prep_ai_plan_requests"');
    expect(db).toContain("CREATE TABLE IF NOT EXISTS prep_ai_plans");
    expect(db).toContain("CREATE TABLE IF NOT EXISTS prep_ai_plan_requests");
    expect(db).toContain("prep_ai_plans_key_uniq");
  });
  it("the interview page carries the company + role picker and the plan renderer", () => {
    expect(iv).toContain('id="ivPlanCompany"');
    expect(iv).toContain('id="ivPlanRole"');
    expect(iv).toContain('id="ivPlanBtn"');
    expect(iv).toContain('id="ivPlanOut"');
    expect(iv).toContain("/api/prep/ai/plan");
    expect(iv).toContain("Build my AI plan");
    expect(iv).toContain("Researching the web");
    expect(iv).toContain("function renderPlan(");
    expect(iv).toContain('id="ivPlanCompanies"');
    expect(iv).toContain('id="ivPlanRoles"');
    expect(iv).toContain("(res.status !== 200 && res.status !== 201) || !res.d.success");
    expect(css).toContain(".plan-form");
    expect(css).toContain(".plan-topics");
    expect(css).toContain(".plan-rounds");
    expect(css).toContain(".plan-q-n");
    expect(css).toContain(".plan-kicker");
  });
  it("aptitude drops the duplicate coach: a target intake feeds the quiz instead", () => {
    expect(apt).not.toContain('id="aptPlanCard"');
    expect(apt).not.toContain("Build my AI plan");
    expect(apt).not.toContain("/api/prep/ai/plan");
    expect(apt).toContain('id="aptTargetCard"');
    expect(apt).toContain('id="aptTargetCompany"');
    expect(apt).toContain('id="aptTargetRole"');
    expect(apt).toContain('id="aptTargetSave"');
    expect(apt).toContain("se_prep_target");
    expect(apt).toContain("&role=");
    expect(apt).toContain("function renderFocus(t)");
    expect(apt).toContain("renderFocus(res.d.data.target)");
  });
});

describe("corporate redesign: promos, heroes, banners, live stats (round 10)", () => {
  const router = read("src/prep/router.ts");
  const css = read("public/prep/prep.css");
  const home = read("public/prep/index.html");
  const apt = read("public/prep/aptitude.html");
  const iv = read("public/prep/interview.html");
  const pf = read("public/prep/proof.html");
  it("the live stats endpoint serves counts only, rate-limited", () => {
    expect(router).toContain('prepRouter.get("/stats", statsLimiter, prepDbGate');
    expect(router).toMatch(/const statsLimiter = rateLimit\(\{/);
    expect(router).toContain("aptitudeQuestions: Number(aptitude.n ?? 0)");
    expect(router).toContain("interviewQuestions: Number(interview.n ?? 0)");
  });
  it("the reports hub leads with a promo strip and hydrates real counters", () => {
    expect(home).toContain('class="prep-promo"');
    expect(home).toContain("Check a company now");
    expect(home).toContain('id="prepLiveStats"');
    expect(home).toContain('id="statCompanies"');
    expect(home).toContain('id="statReports"');
    expect(home).toContain('id="statQuestions"');
    expect(home).toContain("/api/prep/stats");
    expect(home).toContain('class="prep-banner"');
    expect(home).toContain('class="prep-banner prep-banner-final"');
    expect(home).toContain("See Prep Pro");
  });
  it("aptitude and interview open with compact corporate heroes", () => {
    expect(apt).toContain('class="prep-hero-sm"');
    expect(apt).toContain('class="prep-hero-sm-h"');
    expect(apt).toContain("Beat the cut-off with the drills that actually repeat");
    expect(apt).toContain('id="aptTargetCard"');
    expect(apt).toContain('class="prep-banner"');
    expect(apt).toContain("prep/prep.css?v=10");
    expect(iv).toContain('class="prep-hero-sm"');
    expect(iv).toContain("AI-scored mocks");
    expect(iv).toContain('id="ivPlanCard"');
    expect(iv).toContain('class="prep-banner"');
    expect(iv).toContain("prep/prep.css?v=10");
  });
  it("proof sells the contribution with the anonymity promise up top", () => {
    expect(pf).toContain('class="prep-hero-sm"');
    expect(pf).toContain("One anonymised slip from you unlocks pay data for thousands");
    expect(pf).toContain('href="#pfForm"');
    expect(pf).toContain('class="prep-banner"');
    expect(pf).toContain("prep/prep.css?v=10");
    expect(pf).toContain("<b>3 \u00B7 Unlocks</b>"); // original 3-step flow intact
  });
  it("the promo system is fully styled", () => {
    expect(css).toContain(".prep-promo {");
    expect(css).toContain(".prep-promo-cta");
    expect(css).toContain(".prep-hero-sm {");
    expect(css).toContain(".prep-hero-sm-h");
    expect(css).toContain(".prep-banner {");
    expect(css).toContain(".prep-banner-final");
    expect(css).toContain(".prep-live");
  });
});

describe("messaging is open: anyone can start a chat with anyone", () => {
  const route = read("src/routes/messages.ts");
  it("the conversations-with-user route has no deal/connection gate", () => {
    expect(route).not.toContain("NOT_CONNECTED");
    expect(route).not.toContain("after a project, proposal or barter is accepted");
    expect(route).not.toContain("hasAcceptedDeal");
  });
  it("still blocks only the self-message case", () => {
    expect(route).toContain('message: "Cannot message yourself"');
  });
  it("profile shows the Message button to every signed-in viewer", () => {
    const profile = read("public/profile.html");
    expect(profile).not.toContain("/community/connected/");
    expect(profile).toContain("messages.html?to=");
    expect(profile).toContain("paintPresence");
  });
});

describe("round 11: aptitude/interview sessions are Prep Pro; upgrade CTAs hide for members", () => {
  const router = read("src/prep/router.ts");
  const home = read("public/prep/index.html");
  const nav = read("public/js/prep-nav.js");
  const apt = read("public/prep/aptitude.html");
  const iv = read("public/prep/interview.html");
  const css = read("public/prep/prep.css");

  it("the server gates every aptitude and interview session route behind Prep Pro", () => {
    expect(router).toContain("async function requirePrepPro(");
    expect(router).toContain('code: "UPGRADE_REQUIRED"');
    for (const route of [
      'prepRouter.get("/aptitude/topics", authenticate, requirePrepPro',
      'prepRouter.get("/aptitude/quiz", authenticate, aptitudeLimiter, requirePrepPro',
      'prepRouter.post("/aptitude/submit", authenticate, aptitudeLimiter, requirePrepPro',
      'prepRouter.get("/interview/mock", authenticate, interviewLimiter, requirePrepPro',
      'prepRouter.post("/interview/mock/submit", authenticate, interviewLimiter, requirePrepPro',
    ]) expect(router).toContain(route);
  });

  it("upgrade CTAs are marked for hiding and both painters honour the verdict", () => {
    expect(home).toContain('href="#prepProCard" data-pro-upgrade');
    expect(home).toContain("function setUpgradeCtas(on)");
    expect(nav).toContain('document.querySelectorAll("[data-pro-upgrade]")');
    expect(nav).toContain('ups[ui].style.display = on ? "none" : ""');
  });

  it("aptitude sessions render a Prep Pro paywall instead of the quiz controls", () => {
    expect(apt).toContain('id="aptPaywall"');
    expect(apt).toContain('id="aptPaywallPrimary"');
    expect(apt).toContain("Aptitude sessions are part of Prep Pro");
    expect(apt).toContain("data-pro-content");
    expect(apt).toContain("function gate()");
    expect(apt).toContain("headers: authHeaders()");
    expect(apt).toContain('if (res.status === 402) { showPaywall("upgrade")');
  });

  it("interview sessions gate the same way and the plan block is top-level", () => {
    expect(iv).toContain('id="ivPaywall"');
    expect(iv).toContain("the way the panel will"); // outcome-selling paywall headline
    expect(iv).toContain("data-pro-content");
    expect(iv).toContain("function gate()");
    expect(iv).toContain("headers: authHeaders()");
    // Regression guard: the AI-plan block once landed INSIDE the track-chip
    // callback, which left the plan button dead until a chip was clicked.
    // Round 20 removed the chips entirely — the button stays top-level.
    expect(iv).not.toContain("function renderChips()");
    expect(iv).toContain('planBtn.addEventListener("click"');
    const pb = iv.slice(iv.indexOf('planBtn.addEventListener("click"'));
    expect(pb).not.toBe("");
    expect((pb.match(/planBtn\.addEventListener\("click"/g) || []).length).toBe(1);
  });

  it("the paywall ships styled and every prep page cache-busts the stylesheet", () => {
    expect(css).toContain(".prep-paywall {");
    expect(css).toContain(".prep-paywall-ctas");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("prep/prep.css?v=10");
  });
});

describe("round 12: searches always land, skills + package in reports, professional interview list", () => {
  const router = read("src/prep/router.ts");
  const ai = read("src/prep/ai.ts");
  const skeleton = read("src/prep/report-skeleton.ts");
  const report = read("public/prep/report.html");
  const iv = read("public/prep/interview.html");
  const apt = read("public/prep/aptitude.html");
  const css = read("public/prep/prep.css");

  it("the plan route never dead-ends: cap and failures return a plan, not an error", () => {
    expect(router).toContain("limited: true");
    expect(router).toContain('data: { plan, cached: false, aiUsed: false, limited: true, used, limit: FREE_AI_PLANS_PER_DAY }');
    expect(router).toContain("Never dead-end");
    expect(router).not.toContain("AI plan generation failed");
  });

  it("plans carry role-specific skills: prompt, parse, payload and fallback", () => {
    expect(ai).toContain("skillsRequired");
    expect(ai).toContain("skillsRequired: string[]");
    expect(ai).toContain("arr(o.skillsRequired)");
    expect(ai).toContain('import { roleProfile, trackForRole } from "./role-skills"');
    expect(ai).toContain("skillsRequired: profile.skills");
    expect(skeleton).toContain('import { roleSkills } from "./role-skills"');
    expect(skeleton).toContain("roleBrief");
  });

  it("the role profile is real code: different roles, different prep guidance", async () => {
    const { roleProfile, roleSkills } = await import("./role-skills");
    const swe = roleProfile("Software Engineer");
    const analyst = roleProfile("Data Analyst");
    expect(swe.skills).not.toEqual(analyst.skills);
    expect(swe.aptitudeTopics.map((t) => t.topic)).not.toEqual(analyst.aptitudeTopics.map((t) => t.topic));
    expect(swe.rounds[0]!.focus).toMatch(/DSA|coding/i);
    expect(roleSkills("")).toEqual([]);
    expect(roleSkills("Human Resources").join(" ")).toMatch(/STAR/i);
    expect(roleProfile("Something Unmatched").skills.join(" ")).toMatch(/job description/i);
  });

  it("the report opens with skills for the role and the searched role's package", () => {
    expect(report).toContain('id="rpSkillsCard"');
    expect(report).toContain("sec.roleBrief");
    expect(report).toContain('id="rpSkills"');
    expect(report).toContain("brief.skills.map");
    expect(report).toContain("function payRoleMatch(a, targetRole)");
    expect(report).toContain('"rp-pay-match"');
    expect(report).toContain("Package for ");
    expect(report).toContain("No verified pay data for ");
    expect(css).toContain(".rp-pay-match");
    expect(css).toContain(".plan-skills");
  });

  it("interview browse is a professional chip-card list; guidance moved to feedback", () => {
    expect(iv).toContain('class="prep-wrap prep-theme-panel"');
    expect(iv).not.toContain("iv-guide-btn");
    expect(iv).not.toContain("bindGuideToggles");
    expect(iv).toContain("iv-tags");
    expect(iv).toContain("iv-tag iv-tag-");
    expect(iv).toContain("esc(it.guidance)"); // coaching line survives in feedback
    expect(css).toContain(".prep-theme-panel {");
    expect(css).toContain("--prep-violet: #1D4ED8");
  });

  it("the plan page renders the skills chips and the daily-limit notice", () => {
    expect(iv).toContain("p.skillsRequired && p.skillsRequired.length");
    expect(iv).toContain("Skills you will be judged on");
    expect(iv).toContain("Live web research is used up for today");
    expect(iv).toContain("renderPlan(res.d.data.plan, !!res.d.data.limited)");
  });
});

describe("round 13: role-weighted aptitude, researched mock brief, member CTA fixes", () => {
  const home = read("public/prep/index.html");
  const nav = read("public/js/prep-nav.js");
  const apt = read("public/prep/aptitude.html");
  const iv = read("public/prep/interview.html");
  const router = read("src/prep/router.ts");

  it("a member never sees a buy-price CTA, and an interrupted verify heals itself", () => {
    expect(home).toMatch(/id="prepProBuy"[^>]*data-pro-upgrade/);
    expect(home).toContain('class="prep-pro-price-row" data-pro-upgrade');
    expect(home).toContain('class="prep-banner" data-pro-upgrade');
    expect(home).toContain('proBuy.style.display = "none"');
    expect(home).toContain('localStorage.setItem("se_pro_pend"');
    expect(nav).toContain('localStorage.getItem("se_pro_pend"');
    expect(nav).toContain("location.reload();");
    expect(nav).not.toMatch(/window\.location\.reload/);
  });

  it("the aptitude quiz samples by the role and its cached plan weightage", () => {
    expect(router).toContain("pickQuizWeighted(rows,");
    expect(router).toContain("aptitudeWeights(role)");
    expect(router).toContain("weightsFromPlanTopics(plan.aptitudeTopics)");
    expect(router).toContain('focusSource: "plan"');
    expect(router).toContain("cachedPlanFor(company, role)");
    expect(router).toContain("target: role ? { company, role, focus, focusSource } : null");
  });

  it("the mock researches the company + role and answers with an honest brief", () => {
    expect(router).toContain("async function interviewBriefFor(");
    expect(router).toContain("const brief = role.length >= 2 ? await interviewBriefFor(company, role) : null;");
    expect(router).toContain("trackForRole(role)");
    expect(router).toContain("total: picked.length, brief }");
    expect(iv).toContain('id="mockBrief"');
    expect(iv).toContain("function renderBrief(b)");
    expect(iv).toContain("Not company-verified");
    expect(iv).toContain("Researching ");
    expect(iv).toContain("writeTarget(company, role)");
    expect(apt).toContain("writeTarget({ company: company, role: role });"); // target flows both ways
  });

  it("role helpers map roles to interview tracks and aptitude weights", async () => {
    const { aptitudeWeights, trackForRole, weightsFromPlanTopics } = await import("./role-skills");
    expect(trackForRole("Software Engineer")).toBe("engineering");
    expect(trackForRole("Data Analyst")).toBe("data");
    expect(trackForRole("Human Resources")).toBe("business");
    expect(trackForRole("")).toBe(null);
    const w = aptitudeWeights("Software Engineer");
    expect(w.quant + w.logical + w.verbal).toBe(100);
    const pw = weightsFromPlanTopics([
      { topic: "Quantitative aptitude", weight: 60 },
      { topic: "Verbal ability", weight: 40 },
    ]);
    expect(pw.quant).toBe(60);
    expect(pw.verbal).toBe(40);
  });

  it("both heroes show the three-step flow and the target chips are honest", () => {
    expect(apt).toContain('class="prep-steps"');
    expect(apt).toContain("Set your target");
    expect(iv).toContain('class="prep-steps"');
    expect(iv).toContain("Type your real answer");
    expect(iv).toContain("Search a company pack");
    expect(iv).not.toContain("last 10 years"); // no fabricated history claims
    expect(apt).toContain('class="apt-focus"'); // weighted-drill evidence renders in the quiz card
  });
});

describe("round 14: optional post covers (text-only posts allowed)", () => {
  const community = read("src/routes/community.ts");
  const schema = read("src/db/schema/community.ts");
  const feed = read("public/feed.html");

  it("server drops the cover-required 400 but keeps the REEL video rule", () => {
    expect(community).not.toContain("Every post needs a cover");
    expect(community).toContain('if (k === "REEL" && !cleanMedia.some((m) => m.type === "video"))');
    expect(community).toContain("Clips need a short video");
  });
  it("coverUrl stays nullable in the schema — no DDL needed", () => {
    expect(schema).toMatch(/coverUrl: text\("cover_url"\)/);
  });
  it("composer copy and client validation treat media as optional", () => {
    expect(feed).not.toContain("Every post needs a cover");
    expect(feed).toContain("Add a short video for your clip."); // REEL keeps its video check
    expect(feed).toMatch(/\(optional \u2014 image or short video\)/);
    expect(feed).toContain("a photo or clip is optional");
  });
});

describe("round 14: orders page is barter-only (Community + Exchanges)", () => {
  const orders = read("public/orders.html");

  it("keeps the two barter tabs and drops the retired marketplaces", () => {
    expect(orders).toContain('data-tab="community"');
    expect(orders).toContain(">Barter<");
    expect(orders).toContain('data-tab="exchanges"');
    expect(orders).not.toContain("Services (old)");
    expect(orders).not.toContain("Projects (old)");
  });
  it("drops the Buying/Selling scope row and its handlers", () => {
    expect(orders).not.toContain("scopeSeg");
    expect(orders).not.toContain("as-buyer");
    expect(orders).not.toContain("as-seller");
  });
  it("no dead JS: legacy/projects loaders are gone and pending-open is community-only", () => {
    expect(orders).not.toContain("loadLegacy");
    expect(orders).not.toContain("loadProjects");
    expect(orders).not.toContain("handleProj");
    expect(orders).not.toContain("openLegacyDetail");
    expect(orders).not.toContain("projCard");
    expect(orders).toContain("function loadExchanges()");
    expect(orders).toContain("function loadCommunity()");
    expect(orders).toContain("var kindLabels = { BARTER: 'Barter offers' };");
    expect(orders).toContain("Post a barter on the feed");
  });
});

describe("round 14: interview practice upgrades (timer, saved drills, STAR)", () => {
  const ivPage = read("public/prep/interview.html");

  it("browse cards get a save-star backed by localStorage", () => {
    expect(ivPage).toContain("se_iv_bookmarks");
    expect(ivPage).toContain("data-star=");
    expect(ivPage).toContain("function starBtn(id)");
  });
  it("the static bank chips and saved filter are gone — packs replaced the list", () => {
    expect(ivPage).not.toContain('id="diffChips"');
    expect(ivPage).not.toContain('id="savedToggle"');
    expect(ivPage).not.toContain('id="trackChips"');
    expect(ivPage).not.toContain("if (savedOnly) list = list.filter");
    expect(ivPage).not.toContain('id="browseList"');
    expect(ivPage).toContain('id="packCompany"');
    expect(ivPage).toContain("/api/prep/interview/packs");
  });
  it("mock questions carry a 2:00 answer timer and behavioural STAR tips", () => {
    expect(ivPage).toContain("Start 2:00 answer timer");
    expect(ivPage).toContain("data-timer=");
    expect(ivPage).toContain("iv-star-tip");
    expect(ivPage).toContain("STAR: Situation");
  });
  it("mocks completed on the device are counted in the intro", () => {
    expect(ivPage).toContain('id="ivMockStat"');
    expect(ivPage).toContain("se_iv_stats");
    expect(ivPage).toContain("bumpMockCount()");
  });
});

describe("round 14: the free taste that sells Pro (sample + grounded mock + outcome paywall)", () => {
  const router = read("src/prep/router.ts");
  const ivPage = read("public/prep/interview.html");

  it("public sample endpoint serves 3 questions WITH guidance, no auth", () => {
    expect(router).toContain('prepRouter.get("/interview/sample", interviewLimiter, prepDbGate');
    expect(router).not.toMatch(/interview\/sample", authenticate/);
    expect(router).toContain("sampleInterviewQuestions()");
  });
  it("the sample card sits outside the Pro lock so free visitors always see quality", () => {
    expect(ivPage).toContain('id="sampleCard"');
    expect(ivPage).toMatch(/id="sampleCard">[\s\S]*?<\/section>/);
    const sample = ivPage.slice(ivPage.indexOf('id="sampleCard"'), ivPage.indexOf('id="ivPaywall"'));
    expect(sample).not.toContain("data-pro-content");
    expect(ivPage).toContain("/api/prep/interview/sample");
    expect(ivPage).toContain("What interviewers look for");
  });
  it("grounded mocks inject company-researched practice questions", () => {
    expect(ivPage).toContain('id="mockCo"');
    expect(ivPage).toContain("Research says ");
    expect(ivPage).toContain("brief.grounded && brief.expect");
    expect(ivPage).toContain('data-timer="co-');
  });
  it("the paywall sells the loop and names the visitor's target company", () => {
    expect(ivPage).toContain('id="ivPaywallCo"');
    expect(ivPage).toContain("You&rsquo;ve seen the free sample above");
    expect(ivPage).toContain("the way the panel will");
    expect(ivPage).toContain('coEl.textContent = t && t.company');
  });
});

describe("round 15: resume vs target role — free AI taste, text never stored", () => {
  const router = read("src/prep/router.ts");
  const schema = read("src/prep/schema.ts");
  const ddl = read("src/prep/db.ts");
  const ivPage = read("public/prep/interview.html");

  it("check endpoint: auth + limiter + free daily quota, NOT Pro-gated", () => {
    expect(router).toMatch(/prepRouter\.post\(\s*"\/resume\/check",\s*authenticate,\s*resumeCheckLimiter,\s*prepDbGate/);
    expect(router).not.toMatch(/"\/resume\/check",[\s\S]{0,120}?requirePrepPro/);
    expect(router).toContain("const FREE_RESUME_CHECKS_PER_DAY = 1;");
    expect(router).toContain("countResumeChecksToday(req.user!.id)");
    expect(router).toContain("generateResumeCheck({ resume: text");
  });
  it("the resume text is never persisted — usage count table only", () => {
    expect(schema).toContain('pgTable("prep_resume_checks"');
    expect(schema).toMatch(/prepResumeChecksTable = pgTable\("prep_resume_checks", \{\s*id: uuid\("id"\)[\s\S]*?userId: uuid\("user_id"\)[\s\S]*?createdAt/);
    expect(schema).not.toMatch(/prep_resume_checks"[\s\S]{0,300}?text\(/);
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS prep_resume_checks");
    expect(ddl).toContain("prep_resume_checks_user_idx");
  });
  it("exhausted quota or dead AI answers with the checklist — never an error", () => {
    expect(router).toContain("limited: true, used, limit, target, checklist: skills");
    expect(router).toContain('note: "AI check is unavailable right now');
    expect(router).toContain("honest checklist, no usage consumed, never 500");
  });
  it("the card is a free taste outside the Pro lock, honestly labeled", () => {
    const slice = ivPage.slice(ivPage.indexOf('id="resumeCard"'), ivPage.indexOf('id="ivPaywall"'));
    expect(slice).not.toBe("");
    expect(slice).not.toContain("data-pro-content");
    expect(ivPage).toContain("/api/prep/resume/check");
    expect(ivPage).toContain("Free AI check");
    expect(ivPage).toContain("never stored");
    expect(ivPage).toContain("not a guarantee");
    expect(ivPage).toContain("Add at least 100 characters");
  });
  it("the check follows the active target and updates when a plan is built", () => {
    expect(ivPage).toContain("function updateResumeTarget()");
    expect(ivPage).toContain("updateResumeTarget();");
    expect(ivPage).toContain("currentTarget()");
  });
});

describe("round 16: Pro members never see the sell — resume file upload, zero new deps", () => {
  const router = read("src/prep/router.ts");
  const ivPage = read("public/prep/interview.html");
  const nav = read("public/js/prep-nav.js");
  const pkg = read("package.json");

  it("upload endpoint: auth + limiter + memory multer, free tier allowed, nothing stored", () => {
    expect(router).toMatch(
      /prepRouter\.post\(\s*"\/resume\/upload",\s*authenticate,\s*resumeUploadLimiter,\s*prepDbGate,\s*resumeDocUpload\.single\("file"\)/,
    );
    expect(router).not.toMatch(/"\/resume\/upload",[\s\S]{0,160}?requirePrepPro/);
    const slice = router.slice(router.indexOf("Resume file upload"), router.indexOf("Proof / evidence pipeline"));
    expect(slice).not.toBe("");
    expect(slice).toContain("extractResumeText(req.file.buffer");
    expect(slice).not.toMatch(/uploadToSupabase|insert\(|saveAiPlan|recordResumeCheck/);
    expect(slice).toContain("written to disk or stored");
  });

  it("the extractor reads PDF/DOCX/TXT with node builtins only (deploy runs no npm install)", () => {
    const ext = read("src/prep/resume-text.ts");
    expect(ext).toContain("export function extractResumeText");
    expect(ext).toContain('from "node:zlib"');
    expect(ext).toContain("word/document.xml");
    expect(ext).toContain("beginbfchar");
    expect(ext).toContain("Upload a PDF, DOCX or text file");
    expect(ext).toContain("Paste the text instead");
    expect(pkg).not.toContain("pdf-parse");
    expect(pkg).not.toContain("mammoth");
  });

  it("Pro members lose the sell: CTA hidden, sample copy and quota kicker rewritten", () => {
    expect(ivPage).toContain('id="sampleUpsell"');
    expect(ivPage).toContain('id="sampleSub"');
    expect(ivPage).toContain('id="resumeKick"');
    expect(ivPage).toContain("function applyProExtras()");
    expect(ivPage).toMatch(/isPro.*applyProExtras\(\)/);
    expect(ivPage).toContain('up.style.display = "none"');
    expect(ivPage).toContain("Part of Prep Pro \\u2014 unlimited AI answer scores, full company packs and AI-scored mocks.");
    expect(ivPage).toContain('kick.textContent = "AI resume checks \\u00B7 unlimited"');
  });

  it("upload fills the same textarea the check reads — review before spending a check", () => {
    expect(ivPage).toContain('id="resumeFile"');
    expect(ivPage).toContain('accept=".pdf,.docx,.txt');
    expect(ivPage).toContain('"/api/prep/resume/upload"');
    expect(ivPage).toContain("new FileReader()");
    expect(ivPage).toContain("function fillResumeText(");
    expect(ivPage).toContain('fd.append("file", f)');
    expect(ivPage).toContain('headers: authHeaders(), body: fd');
    expect(ivPage).toContain("5 * 1024 * 1024");
  });

  it("versions bumped in lockstep so stale cached pages self-heal", () => {
    expect(nav).toContain("var WANT_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("window.PREP_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
  });
});

describe("round 17: public daily drill — different questions every day", () => {
  const router = read("src/prep/router.ts");
  const helpers = read("src/prep/interview.ts");
  const ivPage = read("public/prep/interview.html");
  const nav = read("public/js/prep-nav.js");

  it("today endpoint is public: limiter + db gate, never behind auth or Pro", () => {
    expect(router).toContain('prepRouter.get("/interview/today", interviewLimiter, prepDbGate');
    expect(router).not.toMatch(/"\/interview\/today",\s*authenticate/);
    expect(router).not.toMatch(/"\/interview\/today"[\s\S]{0,80}?requirePrepPro/);
    expect(router).toContain("dailyDrillQuestions(");
    expect(router).toContain("dailyDrillCodes(");
    expect(router).toContain("id: `today-${i}`");
    expect(router).toContain('res.json({ success: true, data: { day, questions: out } })');
  });

  it("the set is seeded by the UTC calendar date — same day everywhere, fresh tomorrow", () => {
    expect(helpers).toContain("export const TODAY_DRILL_SIZE = 6;");
    expect(helpers).toContain("export function utcDayIndex");
    expect(helpers).toContain("export function utcDayLabel");
    expect(helpers).toContain("function mulberry32");
    expect(helpers).toContain("dayIndex + 0x9e3779b9");
    expect(helpers).toContain("localeCompare(b)");
    // The drill block itself must be random-free (pickMock stays random on
    // purpose — mocks are meant to differ per session).
    const drill = helpers.slice(
      helpers.indexOf("export const TODAY_DRILL_SIZE"),
      helpers.indexOf("export interface InterviewQuestionPublic"),
    );
    expect(drill).not.toBe("");
    expect(drill).not.toContain("Math.random");
  });

  it("the card sits above the sample, reuses one renderer, never dead-ends", () => {
    const todayAt = ivPage.indexOf('id="todayCard"');
    const sampleAt = ivPage.indexOf('id="sampleCard"');
    expect(todayAt).toBeGreaterThan(-1);
    expect(sampleAt).toBeGreaterThan(todayAt);
    expect(ivPage).toContain('id="todayList"');
    expect(ivPage).toContain('"/api/prep/interview/today"');
    expect(ivPage).toContain("changes at midnight UTC");
    expect(ivPage).toContain('wireFreeList("todayList", todayHtml, "/api/prep/interview/today"');
    expect(ivPage).toContain('wireFreeList("sampleList", sampleHtml, "/api/prep/interview/sample"');
    expect(ivPage).toContain('freeQuestionHtml(q, "sg-")');
    expect(ivPage).toContain('freeQuestionHtml(q, "tg-")');
    expect(ivPage).toContain("refresh to retry");
    expect(ivPage).toContain("No account needed");
  });

  it("the sample copy now sells mocks and feedback, not just question count", () => {
    expect(ivPage).toContain("Prep Pro opens full company packs and scores every mock answer.");
    expect(ivPage).not.toContain("Prep Pro unlocks all 24 questions");
  });

  it("versions bumped in lockstep (page changed, nav script changed)", () => {
    expect(nav).toContain("var WANT_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("window.PREP_V = 15;");
  });
});

describe("round 18: an expired se_token self-heals via the shared SeAuth helper", () => {
  const authJs = read("public/js/se-auth.js");
  const nav = read("public/js/prep-nav.js");
  const ivPage = read("public/prep/interview.html");
  const aptPage = read("public/prep/aptitude.html");
  const home = read("public/prep/index.html");
  const reportPage = read("public/prep/report.html");
  const proofPage = read("public/prep/proof.html");

  it("se-auth.js exchanges the rotating refresh token, serialized, storage kept on failure", () => {
    expect(authJs).toContain("window.__seAuthRefreshP");
    expect(authJs).toContain('fetch("/api/auth/refresh"');
    expect(authJs).toContain("refreshToken");
    expect(authJs).toContain("function haveSession()");
    expect(authJs).toContain('lsSet("se_token", access)');
    expect(authJs).toContain('lsSet("se_refresh", refresh)');
    // Refresh failure must NEVER clear storage: a sibling tab may have just
    // rotated the token and written the fresh pair.
    expect(authJs).not.toContain("localStorage.removeItem");
    // Content-Type appears exactly once — on the JSON refresh call; FormData
    // bodies keep their multipart boundary (SeAuth only ever sets Authorization).
    expect((authJs.match(/Content-Type/g) || []).length).toBe(1);
    expect(authJs).toContain('"Content-Type": "application/json"');
    expect(authJs).toContain('headers["Authorization"] = "Bearer " + t');
    // One retry on401, then the original response goes back to the caller.
    expect(authJs).toContain("if (r.status !== 401) return r;");
    expect(authJs).toContain("return refresh().then(function (ok) {");
  });

  it("every prep page loads se-auth (non-deferred) before the nav and inline gates", () => {
    for (const p of PREP_PAGES) {
      const src = read(p);
      const seAt = src.indexOf("/js/se-auth.js");
      const navAt = src.indexOf("/js/prep-nav.js");
      expect(seAt, p).toBeGreaterThan(-1);
      expect(navAt, p).toBeGreaterThan(seAt);
      expect(src, p).toContain('<script src="/js/se-auth.js?v=1"></script>');
      expect(src, p).not.toContain('/js/se-auth.js" defer');
    }
  });

  it("interview + aptitude gates treat a refresh-only session as signed in", () => {
    for (const pair of [[ivPage, "interview"], [aptPage, "aptitude"]]) {
      const src = pair[0];
      const name = pair[1];
      expect(src, name).toContain("function haveSession()");
      expect(src, name).toContain("SeAuth.haveSession()");
      expect(src, name).toContain('proFetch("/api/prep/pro/status")');
      expect(src, name).toContain("SeAuth.fetch(url, { credentials: \"same-origin\" })");
      expect(src, name).toContain('if (!haveSession()) { showPaywall("signin"); return; }');
      // No raw status fetch may remain — it would 401 on an aged token.
      expect(src, name).not.toMatch(/(^|[^A-Za-z])fetch\("\/api\/prep\/pro\/status"/);
    }
  });

  it("index pro panel, checkout, verify and history fetch through the refreshing helper", () => {
    expect(home).toContain("function proFetch(url, opts)");
    expect(home).toContain('proFetch("/api/prep/pro/status")');
    expect(home).toContain('proFetch("/api/prep/pro/verify"');
    expect(home).toContain('proFetch("/api/prep/pro/order"');
    expect(home).toContain('proFetch("/api/prep/my/reports")');
    expect(home).toContain("SeAuth.haveSession()");
    expect(home).not.toMatch(/(^|[^A-Za-z])fetch\("\/api\/prep\/pro\/(status|order|verify)"/);
    // A captured payment survives a dead session: 401 keeps the stash (the
    // nav self-heal retries it) while still sending the member to /login.
    expect(home).toContain("r.status >= 500 || r.status === 401");
    expect(home).toContain("if (v.status === 401) { sessionExpiredPro(); return; }");
  });

  it("report + proof gate on the session and fetch through seFetch", () => {
    const guard =
      'if (!(window.SeAuth ? SeAuth.haveSession() : localStorage.getItem("se_token")))';
    for (const src of [reportPage, proofPage]) {
      expect(src).toContain(guard);
      expect(src).toContain("function seFetch(url, opts)");
      expect(src).toContain("SeAuth.fetch(url, o)");
      expect(src).not.toContain("headers: auth");
    }
    expect(reportPage).toContain('seFetch("/api/prep/companies/"');
    expect(proofPage).toContain('seFetch("/api/prep/proof", { method: "POST", body: fd })');
    expect(proofPage).toContain('seFetch("/api/prep/proof/my")');
    expect(proofPage).toContain("function esc(s)");
    expect(proofPage).toContain('var errEl = document.getElementById("pfErr");');
  });

  it("nav chip, avatar and payment self-heal recover through SeAuth", () => {
    expect(nav).toContain("window.SeAuth && window.SeAuth.fetch");
    expect(nav).toContain('seFetch("/api/prep/pro/status"');
    expect(nav).toContain("if (!(window.SeAuth ? SeAuth.haveSession() : proTok))");
    expect(nav).toContain('seFetch("/api/auth/me"');
    expect(nav).toContain("if (window.SeAuth ? SeAuth.haveSession() : pendTok)");
    expect(nav).toContain('seFetch("/api/prep/pro/verify"');
    // The 401 that keeps the paid stash: never drop money over auth failure.
    expect(nav).toContain("r.status >= 500 || r.status === 401");
    // The 401 that drops the chip only after refresh was exhausted.
    expect(nav).toContain("// Refresh (SeAuth) exhausted — the session is truly gone.");
    expect(nav).toContain("data-prep-pro-chip");
  });

  it("versions bumped in lockstep (nav + all five pages changed)", () => {
    expect(nav).toContain("var WANT_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("window.PREP_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
  });
});

describe("round 19: the plan card can roll fresh questions (never a repeat, never dead)", () => {
  const router = read("src/prep/router.ts");
  const ai = read("src/prep/ai.ts");
  const iv = read("public/prep/interview.html");
  const apt = read("public/prep/aptitude.html");
  const nav = read("public/js/prep-nav.js");

  it("POST /ai/plan/questions reuses the plan's gates, allowance and cached-avoid merge", () => {
    const qIdx = router.indexOf('"/ai/plan/questions"');
    expect(qIdx).toBeGreaterThan(router.indexOf('prepRouter.post("/ai/plan", authenticate'));
    expect(router.slice(qIdx, qIdx + 140)).toMatch(/authenticate,\s*aiPlanLimiter,\s*prepDbGate/);
    expect(router).toContain("generatePrepQuestions({ company: { name: company.name }, role, avoid })");
    expect(router).toContain("fallbackPlanQuestions(role, avoid)");
    expect(router).toContain(
      "const overQuota = !isProUser && (await countAiPlanRequestsToday(req.user!.id)) >= FREE_AI_PLANS_PER_DAY;",
    );
    expect(router).toContain("if (cached?.plan?.questions?.length) {");
    expect(router).toContain("avoid.push(q.question);");
    expect(router).toContain("aiUsed: true, limited: false");
    expect(router).toContain("aiUsed: false, limited: overQuota");
    expect(router).toContain('console.error("[prep] ai plan questions failed:"');
    // Only genuine AI answers spend the daily allowance (same rule as plans).
    expect(router.slice(qIdx)).toMatch(/recordAiPlanRequest\(req\.user!\.id\);[\s\S]{0,80}status\(201\)/);
    // No error status can dead-end the button: every branch answers with questions.
    const qBody = router.slice(qIdx, router.indexOf("// ---- Aptitude practice", qIdx));
    expect(qBody).not.toContain("status(402)");
    expect(qBody).not.toContain("status(503)");
  });

  it("the questions AI pass is text-only with a hard never-repeat contract", () => {
    expect(ai).toContain("PLAN_QUESTIONS_SYSTEM_PROMPT");
    expect(ai).toContain("do not repeat or lightly rephrase");
    expect(ai).toContain("export function parseQuestionsResponse(raw: string, avoid: string[] = [])");
    expect(ai).toContain("export async function generatePrepQuestions(");
    expect(ai).toContain("export function fallbackPlanQuestions(role: string, avoid: string[] = [])");
    expect(ai).toContain('if (!GEMINI_API_KEY) return null;');
    const gen = ai.slice(
      ai.indexOf("export async function generatePrepQuestions"),
      ai.indexOf("export function fallbackPlanQuestions"),
    );
    expect(gen).not.toBe("");
    expect(gen).toContain("PLAN_QUESTIONS_SYSTEM_PROMPT");
    expect(gen).toContain("Already seen (never repeat these):");
    expect(gen).not.toContain("gatherSources"); // no web research: works on starter plans too
  });

  it("the local pool answers when AI can't: role questions, then the bank, minus seen", () => {
    expect(ai).toContain("INTERVIEW_BANK.filter(");
    expect(ai).toContain("b.guidance.slice(0, 200)");
    expect(ai).toContain("profile.questions.slice(0, 6)");
    expect(ai).toContain("seen.has(key)");
  });

  it("the plan card ships the button after the list, the avoid roll and the box swap", () => {
    const qsBoxAt = iv.indexOf('<div class="plan-qs">');
    const btnAt = iv.indexOf("data-plan-qs-more");
    const noteAt = iv.indexOf("data-plan-qs-note");
    expect(qsBoxAt).toBeGreaterThan(-1);
    expect(btnAt).toBeGreaterThan(qsBoxAt);
    expect(noteAt).toBeGreaterThan(btnAt);
    expect(iv).toContain(">Generate new questions</button>");
    expect(iv).toContain('class="prep-btn prep-btn-ghost"');
    expect(iv).toContain("function planQsHtml(qs)");
    expect(iv).toContain("planQsHtml(p.questions)");
    expect(iv).toContain('planOut.querySelector(".plan-qs")');
    expect(iv).toContain("planShownQs = qs");
    expect(iv).toContain("planOut.addEventListener(\"click\"");
    expect(iv).toContain('planPost("/api/prep/ai/plan/questions"');
    expect(iv).toContain("avoid: planShownQs.map(function (q) { return q.question; })");
    expect(iv).toContain("planTarget = { company: company, role: role };");
    expect(iv).toContain('b.textContent = "Generating..."');
    // SeAuth carries the roll so an aged token cannot kill it mid-session.
    expect(iv).toContain("if (window.SeAuth) return SeAuth.fetch(url, opts);");
    // The coach stays interview-only.
    expect(apt).not.toContain("data-plan-qs-more");
    expect(apt).not.toContain("/api/prep/ai/plan/questions");
  });

  it("versions bumped in lockstep (interview page + nav script changed)", () => {
    expect(nav).toContain("var WANT_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("window.PREP_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
  });
});

describe("round 20: company packs + AI-scored answers, generic bank retired", () => {
  const router = read("src/prep/router.ts");
  const schema = read("src/prep/schema.ts");
  const db = read("src/prep/db.ts");
  const ai = read("src/prep/ai.ts");
  const helpers = read("src/prep/interview.ts");
  const packsDb = read("src/prep/packs-db.ts");
  const ivPage = read("public/prep/interview.html");
  const home = read("public/prep/index.html");
  const nav = read("public/js/prep-nav.js");

  it("the free taste endpoint is a rate-limited POST, never behind Pro", () => {
    expect(router).toContain('prepRouter.post("/interview/answer/score", authenticate, answerScoreLimiter, prepDbGate');
    expect(router).not.toMatch(/"\/interview\/answer\/score"[\s\S]{0,140}?requirePrepPro/);
    expect(router).toContain("const FREE_ANSWER_SCORES_PER_DAY = 1;");
    expect(router).toContain("used >= limit");
    // honest failure: AI down still answers with guidance, never a dead-end 500
    expect(router).toContain('scored: false');
    expect(router).toContain("AI scoring is unavailable right now");
    // only a genuine score spends the daily quota; the answer itself is never stored
    expect(router).toContain("await recordAnswerScore(req.user!.id); // only genuine scores count");
  });

  it("the score quota lives in a count-only table (answer text never persisted)", () => {
    expect(schema).toContain("prepAnswerScoresTable");
    expect(schema).toContain('"prep_answer_scores"');
    expect(db).toContain("CREATE TABLE IF NOT EXISTS prep_answer_scores");
    const at = schema.indexOf("prepAnswerScoresTable");
    const open = schema.indexOf("{", at);
    const scoreTable = schema.slice(open, schema.indexOf("});", at));
    expect(scoreTable).toContain("userId");
    expect(scoreTable).toContain("createdAt");
    expect(scoreTable).not.toContain("answer"); // usage count only, never the text
  });

  it("packs are MEMBER_REPORTED: labeled, deduped, quota-capped, PENDING-safe", () => {
    expect(router).toContain('prepRouter.get("/interview/packs", authenticate, interviewLimiter, prepDbGate');
    expect(router).toContain('prepRouter.post("/interview/packs/submit", authenticate, packSubmitLimiter, prepDbGate');
    expect(packsDb).toContain("export const PACKS_PER_USER_PER_DAY = 10;");
    expect(packsDb).toContain("MEMBER_REPORTED by design");
    expect(router).toContain("findDuplicatePackQuestion(co.id, normalizePackQuestion");
    expect(router).toContain("createPendingCompany(db, { name: company, createdBy: req.user!.id })");
    expect(router).toContain("reported: true");
    expect(router).toContain("listPackQuestions");
    expect(schema).toContain("prepCompanyQuestionsTable");
    expect(schema).toContain('"prep_company_questions"');
    expect(db).toContain("CREATE TABLE IF NOT EXISTS prep_company_questions");
    // never dead-end: an unknown company still answers honestly
    expect(router).toContain("data: { found: false, company, total: 0");
  });

  it("the mock scores every typed answer in one AI pass and rolls up readiness", () => {
    expect(router).toContain("generateAnswerScores({");
    expect(router).toContain("summarizeAiScores(");
    expect(router).toContain("aiUsed: readiness !== null");
    expect(router).toContain("answers: z.record(z.string(), z.string().max(1500))");
    expect(ai).toContain("export const ANSWER_SCORING_SYSTEM_PROMPT");
    expect(ai).toContain("export function parseAnswerScoresResponse");
    expect(ai).toContain("input.items.slice(0, 8)"); // one provider round trip per batch
    expect(helpers).toContain("export function summarizeAiScores(");
    expect(helpers).toContain("export function normalizePackQuestion(");
    expect(helpers).toContain("export function cleanPackText(");
  });

  it("the page sells packs + scoring and the generic bank list is gone", () => {
    expect(ivPage).toContain('id="packCompany"');
    expect(ivPage).toContain('id="packForm"');
    expect(ivPage).toContain('id="packUpsell"');
    expect(ivPage).toContain("Member-reported &middot; unverified");
    expect(ivPage).toContain("/api/prep/interview/packs");
    expect(ivPage).toContain('data-score-send=');
    expect(ivPage).toContain("/api/prep/interview/answer/score");
    expect(ivPage).toContain('class="iv-answer-ta"');
    expect(ivPage).toContain("data-answer=");
    expect(ivPage).toContain("function scoreResultHtml(");
    // retired surface: tabs, chips, saved filter, the static bank list
    for (const gone of [
      'id="browseList"', 'id="trackChips"', 'id="catChips"', 'id="diffChips"',
      'id="savedToggle"', 'id="savedRow"', "renderChips", "loadBrowse", "setMode",
      "savedOnly", "iv-rate",
    ]) expect(ivPage, gone).not.toContain(gone);
    expect(router).not.toContain('prepRouter.get("/interview/questions"');
  });

  it("the home page copy matches the new offer", () => {
    expect(home).toContain("Company packs of questions candidates were actually asked");
    expect(home).toContain("AI-scored interview answers and full company question packs");
    expect(home).toContain('class="prep-feature" href="/prep/interview"');
  });

  it("versions bumped in lockstep (interview page + nav script changed)", () => {
    expect(nav).toContain("var WANT_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toContain("window.PREP_V = 15;");
    for (const p of PREP_PAGES) expect(read(p), p).toMatch(/prep-nav\.js\?v=\d+/);
  });
});

