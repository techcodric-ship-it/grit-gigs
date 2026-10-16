import { describe, it, expect } from "vitest";
import { parseExternalApplyLink, externalApplyLogTerm } from "./external-apply";

describe("parseExternalApplyLink", () => {
  it("accepts a plain https job URL", () => {
    expect(parseExternalApplyLink("https://company.com/careers/123")).toBe(
      "https://company.com/careers/123",
    );
  });

  it("accepts http URLs and trims whitespace", () => {
    expect(parseExternalApplyLink("  http://example.com/apply ")).toBe(
      "http://example.com/apply",
    );
  });

  it("rejects javascript: URLs so a job row can never trigger script execution", () => {
    expect(parseExternalApplyLink("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs and bare text", () => {
    expect(parseExternalApplyLink("data:text/html,<h1>x</h1>")).toBeNull();
    expect(parseExternalApplyLink("apply on LinkedIn")).toBeNull();
  });

  it("rejects empty, non-string and overlong values", () => {
    expect(parseExternalApplyLink("")).toBeNull();
    expect(parseExternalApplyLink(null)).toBeNull();
    expect(parseExternalApplyLink(undefined)).toBeNull();
    expect(parseExternalApplyLink(123)).toBeNull();
    expect(parseExternalApplyLink("https://" + "a".repeat(2100))).toBeNull();
  });
});

describe("externalApplyLogTerm", () => {
  it("fits the 80-char search_logs term budget", () => {
    const term = externalApplyLogTerm("some-job-id");
    expect(term.startsWith("job-external:")).toBe(true);
    expect(term.length).toBeLessThanOrEqual(80);
  });
});
