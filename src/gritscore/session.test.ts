import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../public/${path}`, import.meta.url)), "utf8");

// A 7-day access token ages out long before the 30-day refresh token, so the
// GritScore pages must exchange se_refresh instead of dead-ending on 401.
describe("GritScore session handling", () => {
  it("loads the shared refresh helper before the client", () => {
    const html = read("gritscore/index.html");
    expect(html).toContain("/js/se-auth.js");
    expect(html.indexOf("se-auth.js")).toBeLessThan(html.indexOf("/assets/gritscore.js"));
  });

  it("loads the refresh helper on the public card too, for owner preview", () => {
    expect(read("gritscore/score.html")).toContain("/js/se-auth.js");
  });

  it("routes authenticated calls through SeAuth with a bearer fallback", () => {
    const js = read("assets/gritscore.js");
    expect(js).toContain("window.SeAuth.fetch");
    expect(js).toContain("window.GS");
    expect(js).toContain("authedFetch");
  });

  it("keeps a refresh-only session on the page instead of bouncing to /", () => {
    const html = read("gritscore/index.html");
    expect(html).toContain("localStorage.getItem('se_refresh')");
  });

  it("shows a sign-in state when the refresh token is gone too", () => {
    const html = read("gritscore/index.html");
    expect(html).toContain('id="sessionDead"');
    expect(html).toContain("sessionSignIn");
  });
});
