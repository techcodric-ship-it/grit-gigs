import { describe, expect, it } from "vitest";

import { looksLikeImage, safePhotoUrl } from "./photo";

describe("safePhotoUrl", () => {
  it("keeps https URLs", () => {
    expect(safePhotoUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  it("keeps files stored under /uploads/gritscore/", () => {
    expect(safePhotoUrl("/uploads/gritscore/1700000000-abc123.png")).toBe("/uploads/gritscore/1700000000-abc123.png");
  });

  it("drops script, data and unknown paths", () => {
    expect(safePhotoUrl("javascript:alert(1)")).toBeNull();
    expect(safePhotoUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safePhotoUrl("http://example.com/a.png")).toBeNull();
    expect(safePhotoUrl("/uploads/other/a.png")).toBeNull();
    expect(safePhotoUrl("/uploads/gritscore/../../etc/passwd")).toBeNull();
    expect(safePhotoUrl("/uploads/gritscore/a.png?x=1")).toBeNull();
  });

  it("treats empty values as no photo", () => {
    expect(safePhotoUrl(null)).toBeNull();
    expect(safePhotoUrl(undefined)).toBeNull();
    expect(safePhotoUrl("   ")).toBeNull();
  });

  it("caps very long URLs", () => {
    const long = "https://cdn.example.com/" + "a".repeat(1000) + ".png";
    expect(safePhotoUrl(long)?.length).toBe(600);
  });
});

describe("looksLikeImage", () => {
  const pad = (head: number[] | string) => {
    const bytes = typeof head === "string" ? Buffer.from(head, "ascii") : Buffer.from(head);
    return Buffer.concat([bytes, Buffer.alloc(32)]);
  };

  it("accepts JPEG, PNG and WebP signatures", () => {
    expect(looksLikeImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLikeImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(looksLikeImage(pad("RIFF\u0000\u0000\u0000\u0000WEBP"))).toBe(true);
  });

  it("rejects other files and short buffers", () => {
    expect(looksLikeImage(pad("%PDF-1.7"))).toBe(false);
    expect(looksLikeImage(pad("<svg xmlns="))).toBe(false);
    expect(looksLikeImage(pad("GIF89a"))).toBe(false);
    expect(looksLikeImage(Buffer.from([0x89, 0x50]))).toBe(false);
  });
});
