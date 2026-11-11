import { describe, expect, it, vi } from "vitest";
import {
  checkProofUrl,
  classifyEvidence,
  detectAbuse,
  detectFileKind,
  isFetchableUrl,
  isSafeSlug,
  normaliseUrl,
  proofFileKind,
  type UrlFetcher,
} from "./evidence";

describe("isFetchableUrl", () => {
  it("accepts ordinary public links", () => {
    expect(isFetchableUrl("https://github.com/asha/billing")).toBe(true);
    expect(isFetchableUrl("http://example.com/portfolio?x=1")).toBe(true);
    expect(isFetchableUrl("https://sub.domain.co.in/work")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isFetchableUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableUrl("ftp://example.com/x")).toBe(false);
  });

  it("rejects loopback and private IPv4 ranges", () => {
    expect(isFetchableUrl("http://127.0.0.1:5432/")).toBe(false);
    expect(isFetchableUrl("http://localhost:3000/")).toBe(false);
    expect(isFetchableUrl("http://10.0.0.5/")).toBe(false);
    expect(isFetchableUrl("http://172.16.4.2/")).toBe(false);
    expect(isFetchableUrl("http://192.168.1.1/")).toBe(false);
    expect(isFetchableUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isFetchableUrl("http://0.0.0.0/")).toBe(false);
  });

  it("rejects private IPv6 and internal hostnames", () => {
    expect(isFetchableUrl("http://[::1]/")).toBe(false);
    expect(isFetchableUrl("http://[fd00::1]/")).toBe(false);
    expect(isFetchableUrl("http://[fe80::1]/")).toBe(false);
    expect(isFetchableUrl("http://metadata.google.internal/")).toBe(false);
    expect(isFetchableUrl("http://printer.local/")).toBe(false);
  });

  it("allows public IPs and a public host that merely contains a private prefix", () => {
    expect(isFetchableUrl("http://8.8.8.8/")).toBe(true);
    expect(isFetchableUrl("https://172.32.0.1/")).toBe(true);
    expect(isFetchableUrl("https://127.example.com/")).toBe(true);
  });
});

describe("checkProofUrl", () => {
  const okFetcher: UrlFetcher = async () => ({ status: 200 });

  it("never calls the network for a private address", async () => {
    const fetcher = vi.fn(okFetcher);
    const result = await checkProofUrl("http://127.0.0.1:5432/", fetcher);
    expect(result.status).toBe("invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a 2xx as ok and a 401 as blocked", async () => {
    expect((await checkProofUrl("https://example.com/a", async () => ({ status: 204 }))).status).toBe("ok");
    expect((await checkProofUrl("https://example.com/a", async () => ({ status: 401 }))).status).toBe("blocked");
  });

  it("falls back from HEAD to GET, then reports dead", async () => {
    const calls: string[] = [];
    const fetcher: UrlFetcher = async (_url, init) => {
      calls.push(init.method);
      return { status: init.method === "HEAD" ? 404 : 404 };
    };
    const result = await checkProofUrl("https://example.com/gone", fetcher);
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(result.status).toBe("dead");
  });

  it("never follows redirects", async () => {
    let redirect: string | undefined;
    const fetcher: UrlFetcher = async (_url, init) => {
      redirect = init.redirect;
      return { status: 301 };
    };
    const result = await checkProofUrl("https://example.com/old", fetcher);
    expect(redirect).toBe("manual");
    expect(result.status).toBe("ok");
  });
});

describe("classifyEvidence", () => {
  it("is deterministic and ignores what the AI might claim", () => {
    expect(classifyEvidence({ url: "https://github.com/a/b" })).toBe("github");
    expect(classifyEvidence({ url: "https://medium.com/@a/post" })).toBe("published");
    expect(classifyEvidence({ url: "https://credl.com/cert/1" })).toBe("liveLink");
    expect(classifyEvidence({ url: "https://example.com/certificate/1" })).toBe("certificate");
    expect(classifyEvidence({ url: "https://example.com/work" })).toBe("liveLink");
    expect(classifyEvidence({ fileName: "proof.png" })).toBe("screenshot");
    expect(classifyEvidence({ fileName: "case-study.pdf" })).toBe("file");
    expect(classifyEvidence({})).toBe("none");
  });
});

describe("abuse checks", () => {
  it("flags reused URLs, short descriptions and missing proof", () => {
    const report = detectAbuse(
      [
        { title: "Billing rewrite", description: "Short", proofUrl: "https://example.com/a", evidenceType: "liveLink" },
        { title: "Billing rewrite 2", description: "A long enough description here", proofUrl: "https://example.com/a/", evidenceType: "liveLink" },
        { title: "Claim", description: "Also a long enough description", proofUrl: null, evidenceType: "none" },
      ],
      ["https://example.com/prior"],
    );
    expect(report.ok).toBe(false);
    expect(report.duplicateUrls).toEqual(["example.com/a"]);
    expect(report.flags.join(" | ")).toContain("description is too short");
    expect(report.flags.join(" | ")).toContain("no proof attached");
  });

  it("treats a URL already used on another card as a duplicate", () => {
    const report = detectAbuse(
      [{ title: "Same link", description: "A perfectly good description", proofUrl: "https://example.com/prior", evidenceType: "liveLink" }],
      ["https://example.com/prior/"],
    );
    expect(report.duplicateUrls).toContain("example.com/prior");
  });

  it("passes clean input", () => {
    const report = detectAbuse([
      { title: "Real project", description: "Shipped a billing pipeline that cut errors 38%", proofUrl: "https://github.com/a/b", evidenceType: "github" },
    ]);
    expect(report.ok).toBe(true);
  });
});

describe("url and file helpers", () => {
  it("normalises for duplicate detection", () => {
    expect(normaliseUrl("HTTPS://WWW.Example.com/Path/?utm_source=x&ref=y")).toBe("example.com/Path");
    expect(normaliseUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseUrl("not a url")).toBeNull();
  });

  it("maps proof file extensions", () => {
    expect(proofFileKind("proof.PDF")).toBe("pdf");
    expect(proofFileKind("shot.jpeg")).toBe("image");
    expect(proofFileKind("run.exe")).toBeNull();
  });

  it("validates magic bytes, not just the extension", () => {
    expect(detectFileKind(Buffer.from("%PDF-1.4 rest"))).toBe("pdf");
    expect(detectFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image");
    expect(detectFileKind(Buffer.from("plain text file contents"))).toBe("text");
    expect(detectFileKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe("unknown");
  });

  it("keeps slugs URL-safe", () => {
    expect(isSafeSlug("asha-rao-4f2a1c")).toBe(true);
    expect(isSafeSlug("Bad Slug")).toBe(false);
    expect(isSafeSlug("-leading")).toBe(false);
  });
});
