// URL safety for source fetching: protocol allowlist, denylist of job/review
// sites that must never be scraped (legal constraint), private-network SSRF
// protection (with optional DNS resolution in production), and a minimal
// robots.txt check for user-agent "*".

import { lookup } from "node:dns/promises";
import net from "node:net";

// Sites we must never fetch, by hostname suffix. Enforced even if a company
// domain points at one of them.
export const SOURCE_DENYLIST = [
  "glassdoor.com",
  "glassdoor.co.in",
  "ambitionbox.com",
  "linkedin.com",
  "indeed.com",
  "indeed.co.in",
  "naukri.com",
  "monster.com",
  "glassdoor.in",
];

export function isDeniedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return SOURCE_DENYLIST.some((d) => h === d || h.endsWith("." + d));
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4-mapped (::ffff:10.0.0.1)
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export interface UrlCheckOptions {
  /** Resolve the hostname and reject private IPs (production). Tests stub it. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** Validate a URL before any network I/O. Denylist and private IPs fail closed. */
export async function checkSourceUrl(raw: string, opts: UrlCheckOptions = {}): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad-protocol" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials-in-url" };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "no-host" };
  if (isDeniedHost(hostname)) return { ok: false, reason: "denied-host" };
  // Bare IP hosts: check immediately, no DNS needed.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return { ok: false, reason: "private-ip" };
  } else if (opts.resolve) {
    let addrs: string[];
    try {
      addrs = await opts.resolve(hostname);
    } catch {
      return { ok: false, reason: "dns-failed" };
    }
    if (!addrs.length) return { ok: false, reason: "dns-empty" };
    if (addrs.some((a) => isPrivateIp(a))) return { ok: false, reason: "private-ip" };
  }
  return { ok: true, url };
}

export async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/** Minimal robots.txt handling: fetch and honor Disallow for user-agent "*". */
export async function fetchRobots(
  origin: string,
  doFetch: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
): Promise<{ disallows: string[] } | null> {
  try {
    const res = await doFetch(new URL("/robots.txt", origin).href, {
      signal: AbortSignal.timeout(3000),
      headers: { "user-agent": "GritAndGigs-PrepBot/1.0 (+https://www.gritandgigs.in)" },
    });
    if (!res.ok) return null; // no robots file: allow
    const body = await res.text();
    const lines = body.split(/\r?\n/).map((l) => l.trim());
    const disallows: string[] = [];
    let applies = false;
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = (rawKey ?? "").trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*";
      } else if (key === "disallow" && applies) {
        if (value) disallows.push(value);
      }
    }
    return { disallows };
  } catch {
    return null; // robots unreachable: allow (documented behavior)
  }
}

export function isPathDisallowed(pathname: string, disallows: string[]): boolean {
  return disallows.some((d) => pathname.startsWith(d));
}
