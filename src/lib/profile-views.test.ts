import { describe, it, expect } from "vitest";
import { summarizeProfileViews } from "./profile-views";

const v = (viewerId: string | null, at: string, viewer?: ProfileViewRowViewer | null) => ({
  viewerId,
  createdAt: new Date(at),
  viewer: viewer ?? null,
});
type ProfileViewRowViewer = NonNullable<Parameters<typeof summarizeProfileViews>[0][number]["viewer"]>;

const ash: ProfileViewRowViewer = { id: "u-ash", firstName: "Asha", lastName: "K", profilePhoto: null, city: "Pune" };

describe("summarizeProfileViews", () => {
  it("groups by viewer, keeps latest timestamp, and sorts most recent first", () => {
    const out = summarizeProfileViews([
      v("u-ash", "2026-01-01T10:00:00Z", ash),
      v("u-ash", "2026-01-03T10:00:00Z", ash),
      v("u-bob", "2026-01-02T10:00:00Z", { id: "u-bob", firstName: "Bob", lastName: null, profilePhoto: null, city: null }),
    ]);
    expect(out.total).toBe(3);
    expect(out.signedIn).toBe(3);
    expect(out.anonymous).toBe(0);
    expect(out.viewers[0].id).toBe("u-ash");
    expect(out.viewers[0].views).toBe(2);
    expect(out.viewers[0].lastViewedAt.toISOString()).toBe("2026-01-03T10:00:00.000Z");
    expect(out.viewers[0].name).toBe("Asha K");
    expect(out.viewers[1].name).toBe("Bob");
  });

  it("counts signed-out views as anonymous without inventing a viewer", () => {
    const out = summarizeProfileViews([v(null, "2026-01-01T10:00:00Z"), v(null, "2026-01-02T10:00:00Z")]);
    expect(out.total).toBe(2);
    expect(out.anonymous).toBe(2);
    expect(out.signedIn).toBe(0);
    expect(out.viewers).toHaveLength(0);
  });

  it("handles deleted viewer accounts gracefully", () => {
    const out = summarizeProfileViews([v("u-gone", "2026-01-01T10:00:00Z", null)]);
    expect(out.viewers[0].name).toBe("Grit&Gigs member");
    expect(out.viewers[0].profilePhoto).toBeNull();
  });

  it("accepts string dates", () => {
    const out = summarizeProfileViews([{ viewerId: "u-ash", createdAt: "2026-01-01T10:00:00Z", viewer: ash }]);
    expect(out.viewers[0].lastViewedAt).toBeInstanceOf(Date);
  });
});
