// SSRF, denylist and robots checks for Prep source fetching.

import { describe, it, expect } from "vitest";
import {
  checkSourceUrl,
  isDeniedHost,
  isPrivateIp,
  isPrivateIPv4,
  isPathDisallowed,
  fetchRobots,
  SOURCE_DENYLIST,
} from "./urls";

const noResolve = undefined;

describe("denylist", () => {
  it("blocks all required job/review sites", () => {
    for (const host of [
      "www.glassdoor.com",
      "glassdoor.co.in",
      "www.ambitionbox.com",
      "linkedin.com",
      "uk.indeed.com",
      "www.naukri.com",
    ]) {
      expect(isDeniedHost(host)).toBe(true);
    }
  });
  it("does not block normal company sites", () => {
    expect(isDeniedHost("infosys.com")).toBe(false);
    expect(isDeniedHost("glassdoor.example.com")).toBe(false);
  });
  it("includes every denylist host from the legal constraint", () => {
    expect(SOURCE_DENYLIST).toEqual(
      expect.arrayContaining(["glassdoor.com", "ambitionbox.com", "linkedin.com", "indeed.com", "naukri.com"]),
    );
  });
});

describe("private IP detection", () => {
  it("flags private and metadata ranges", () => {
    expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    expect(isPrivateIPv4("10.0.0.5")).toBe(true);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("169.254.169.254")).toBe(true); // AWS metadata
    expect(isPrivateIPv4("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("93.184.216.34")).toBe(false);
  });
  it("flags IPv6 loopback and mapped private", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("checkSourceUrl", () => {
  it("accepts a normal https URL", async () => {
    const r = await checkSourceUrl("https://example.com/careers", noResolve);
    expect(r.ok).toBe(true);
  });
  it("rejects non-http protocols", async () => {
    for (const url of ["file:///etc/passwd", "ftp://x.com", "javascript:alert(1)"]) {
      const r = await checkSourceUrl(url, noResolve);
      expect(r.ok).toBe(false);
    }
  });
  it("rejects credentials in URL", async () => {
    const r = await checkSourceUrl("https://user:pass@example.com/", noResolve);
    expect(r.ok).toBe(false);
  });
  it("rejects denied hosts", async () => {
    const r = await checkSourceUrl("https://www.glassdoor.com/Reviews/x", noResolve);
    expect(r).toEqual({ ok: false, reason: "denied-host" });
  });
  it("rejects private IP hosts directly", async () => {
    const r = await checkSourceUrl("http://169.254.169.254/latest/meta-data", noResolve);
    expect(r).toEqual({ ok: false, reason: "private-ip" });
  });
  it("rejects hostnames that resolve to private IPs", async () => {
    const r = await checkSourceUrl("https://evil.example.com/", {
      resolve: async () => ["10.0.0.8"],
    });
    expect(r).toEqual({ ok: false, reason: "private-ip" });
  });
  it("accepts hostnames that resolve to public IPs", async () => {
    const r = await checkSourceUrl("https://good.example.com/", {
      resolve: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
  });
  it("fails closed on DNS failure", async () => {
    const r = await checkSourceUrl("https://nx.example.com/", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r).toEqual({ ok: false, reason: "dns-failed" });
  });
});

describe("robots.txt", () => {
  const robotsBody = (s: string) => ({
    ok: true,
    status: 200,
    text: async () => s,
  });
  it("honors Disallow for user-agent *", async () => {
    const robots = await fetchRobots("https://example.com", async () =>
      robotsBody("User-agent: *\nDisallow: /private/\nDisallow: /tmp\n"),
    );
    expect(robots).not.toBeNull();
    expect(isPathDisallowed("/private/x", robots!.disallows)).toBe(true);
    expect(isPathDisallowed("/careers", robots!.disallows)).toBe(false);
  });
  it("ignores rules for other user-agents", async () => {
    const robots = await fetchRobots("https://example.com", async () =>
      robotsBody("User-agent: Googlebot\nDisallow: /\n"),
    );
    expect(robots!.disallows).toEqual([]);
  });
  it("allows when robots is missing or fails", async () => {
    const missing = await fetchRobots("https://example.com", async () => ({ ok: false, status: 404, text: async () => "" }));
    expect(missing).toBeNull();
    const failing = await fetchRobots("https://example.com", async () => {
      throw new Error("offline");
    });
    expect(failing).toBeNull();
  });
});
