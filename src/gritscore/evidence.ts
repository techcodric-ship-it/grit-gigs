// Evidence classification and abuse checks. Kept pure/isolated so the router
// stays readable and the scoring path never depends on a network call.

import type { EvidenceType } from "./config";

const PUBLISHED_HOSTS = [
  "medium.com",
  "substack.com",
  "dev.to",
  "hashnode.dev",
  "hashnode.com",
  "behance.net",
  "dribbble.com",
  "notion.site",
  "notion.so",
  "figma.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "github.io",
  "gitlab.io",
  "wordpress.com",
  "blogspot.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
];

const GITHUB_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

const CERTIFICATE_HINTS = ["certificate", "certification", "credential", "verify", "badge", "coursera.org", "udemy.com", "credly.com", "accredible.com"];

/** Normalise a proof URL for duplicate detection: lowercased host, no hash,
 *  no tracking params, no trailing slash. Returns null for non-http(s). */
export function normaliseUrl(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const drop = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "ref",
    "source",
  ]);
  for (const key of [...url.searchParams.keys()]) {
    if (drop.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const path = url.pathname.replace(/\/+$/, "");
  const host = url.host.toLowerCase().replace(/^www\./, "");
  const search = url.searchParams.toString();
  return `${host}${path}${search ? `?${search}` : ""}`;
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Deterministic evidence classification. The AI may suggest an evidence type,
 *  but this function is authoritative: proof strength must not be gameable by
 *  asking a language model to call a screenshot a live link. */
export function classifyEvidence(input: {
  url?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  kind?: "file" | "screenshot" | "certificate" | null;
}): EvidenceType {
  if (input.kind === "certificate") return "certificate";
  if (input.kind === "screenshot") return "screenshot";
  const url = input.url ? String(input.url).trim() : "";
  if (url && normaliseUrl(url)) {
    const host = hostOf(url);
    const lower = url.toLowerCase();
    if (GITHUB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "github";
    if (CERTIFICATE_HINTS.some((h) => lower.includes(h))) return "certificate";
    if (PUBLISHED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "published";
    return "liveLink";
  }
  if (input.kind === "file") return "file";
  if (input.mimeType?.startsWith("image/")) return "screenshot";
  if (input.fileName) {
    const ext = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "screenshot";
    return "file";
  }
  return "none";
}

export const PROOF_FILE_TYPES: Record<string, "pdf" | "image" | "text"> = {
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".txt": "text",
  ".md": "text",
};

export function proofFileKind(fileName: string): "pdf" | "image" | "text" | null {
  const ext = String(fileName ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return PROOF_FILE_TYPES[ext] ?? null;
}

/** Magic-byte validation — a renamed .exe must never be stored as a PNG. */
export function detectFileKind(buffer: Buffer): "pdf" | "image" | "text" | "unknown" {
  if (buffer.length < 4) return "unknown";
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const hex = buffer.subarray(0, 12).toString("hex").toLowerCase();
  if (hex.startsWith("89504e47")) return "image"; // PNG
  if (hex.startsWith("ffd8ff")) return "image"; // JPEG
  if (hex.startsWith("47494638")) return "image"; // GIF
  if (hex.startsWith("52494646") && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image";
  // Heuristic for text: mostly printable in the first 512 bytes.
  const sample = buffer.subarray(0, 512);
  const printable = sample.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
  if (sample.length > 0 && printable / sample.length > 0.95) return "text";
  return "unknown";
}

export type UrlCheckStatus = "ok" | "blocked" | "dead" | "invalid";

export interface UrlCheck {
  status: UrlCheckStatus;
  httpStatus: number | null;
  note: string;
}

function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if ([a, b, Number(match[3]), Number(match[4])].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return true;
  if (/^f[cd]/.test(value)) return true; // unique local
  if (/^fe[89ab]/.test(value)) return true; // link-local
  const mapped = value.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * True only for public http(s) endpoints. Proof URLs are fetched from the
 * server, so this blocks loopback, private ranges, link-local addresses and
 * cloud metadata hostnames (SSRF). DNS rebinding is out of scope here because
 * checks never follow redirects and never read the response body.
 */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return false;
  if (host === "metadata.google.internal" || host === "instance-data") return false;
  if (isPrivateIpv4(host)) return false;
  if (isPrivateIpv6(host)) return false;
  return true;
}

export type UrlFetcher = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect?: "manual" | "follow" }) => Promise<{ status: number }>;

const defaultFetcher: UrlFetcher = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  // We never read the body; cancel it so a huge page cannot exhaust sockets.
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
  return { status: res.status };
};

const CHECK_TIMEOUT_MS = 6000;
const CHECK_UA = "GritScoreBot/1.0 (+https://www.gritandgigs.in/gritscore)";

const BLOCKED_STATUSES = new Set([401, 403, 405, 429, 503]);

/** Does the proof URL respond? 2xx/3xx = ok, auth/bot blocks = blocked (not a
 *  lie either way), 404/410/5xx/timeout = dead. */
export async function checkProofUrl(raw: string, fetcher: UrlFetcher = defaultFetcher): Promise<UrlCheck> {
  const normalised = normaliseUrl(raw);
  if (!normalised || !isFetchableUrl(raw)) {
    return { status: "invalid", httpStatus: null, note: "Not a public http(s) link" };
  }
  const target = String(raw).trim();
  const headers = { "user-agent": CHECK_UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-IN,en;q=0.9" };
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetcher(target, {
        method,
        headers: method === "GET" ? { ...headers, range: "bytes=0-2048" } : headers,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        // Never follow a redirect: a public URL could bounce straight to an
        // internal address, and a 3xx already proves the link is reachable.
        redirect: "manual",
      });
      if (res.status >= 200 && res.status < 400) return { status: "ok", httpStatus: res.status, note: "Link responds" };
      if (BLOCKED_STATUSES.has(res.status)) return { status: "blocked", httpStatus: res.status, note: "Link is up but blocks automated checks" };
      if (method === "HEAD") continue; // some hosts reject HEAD with 404; retry GET
      if (res.status === 404 || res.status === 410) return { status: "dead", httpStatus: res.status, note: "Link returns not found" };
      if (res.status >= 400) return { status: "dead", httpStatus: res.status, note: `Link returned ${res.status}` };
    } catch {
      if (method === "HEAD") continue;
      return { status: "dead", httpStatus: null, note: "Link did not respond" };
    }
  }
  return { status: "dead", httpStatus: null, note: "Link did not respond" };
}

export interface AbuseInputItem {
  title: string;
  description: string;
  proofUrl?: string | null;
  evidenceType: EvidenceType;
}

export interface AbuseReport {
  ok: boolean;
  flags: string[];
  /** Normalised URLs that must not count as unique evidence. */
  duplicateUrls: string[];
}

/** Duplicate proof URLs, empty descriptions and placeholder titles are the
 *  three cheapest ways to fake a portfolio. Flag them and neutralise the
 *  duplicated evidence rather than silently inflating a score. */
export function detectAbuse(items: AbuseInputItem[], priorUrls: string[] = []): AbuseReport {
  const flags: string[] = [];
  const duplicateUrls: string[] = [];
  const seen = new Set(priorUrls.map((u) => normaliseUrl(u)).filter((u): u is string => !!u));

  items.forEach((item, index) => {
    const label = `Item ${index + 1}`;
    if ((item.description ?? "").trim().length < 15) flags.push(`${label}: description is too short to be evidence`);
    if (!item.title || item.title.trim().length < 3) flags.push(`${label}: title is missing`);
    if (item.evidenceType === "none") flags.push(`${label}: no proof attached`);
    const normalised = item.proofUrl ? normaliseUrl(item.proofUrl) : null;
    if (normalised && seen.has(normalised)) {
      flags.push(`${label}: proof URL is reused`);
      duplicateUrls.push(normalised);
    } else if (normalised) {
      seen.add(normalised);
    }
  });

  return { ok: flags.length === 0, flags, duplicateUrls };
}

/** Slug charset is deliberately narrow: it ends up in a public URL. */
export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,60}$/.test(slug);
}

/** One-line, human host label for a proof item. */
export function proofLabel(url: string): string {
  const host = hostOf(url);
  return host || "link";
}
