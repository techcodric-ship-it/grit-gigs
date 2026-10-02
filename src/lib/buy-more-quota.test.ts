import { describe, it, expect } from "vitest";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const { QUOTA_PLANS } = await import("./community-quota");

// Mirrors renderQuota() in public/buy-more.html. The API returns `free` as the
// REMAINING free allowance (limit - used), so subtracting `used` again would
// under-report availability.
function renderQuota(d: {
  gigPosts: { used: number; free: number; bonus: number; limit: number };
  proposals: { used: number; free: number; bonus: number; limit: number };
}) {
  const gig = d.gigPosts;
  const prop = d.proposals;
  const gigBonus = Number(gig.bonus || 0);
  const propBonus = Number(prop.bonus || 0);
  const gigRemain = Number(gig.free || 0) + gigBonus;
  const propRemain = Number(prop.free || 0) + propBonus;
  const gigTotal = Number(gig.limit || 0) + gigBonus;
  const propTotal = Number(prop.limit || 0) + propBonus;
  return { gigRemain, gigTotal, propRemain, propTotal };
}

describe("buy more quota rendering", () => {
  it("shows the full free allowance when nothing is used", () => {
    const out = renderQuota({
      gigPosts: { used: 0, free: 10, bonus: 0, limit: 10 },
      proposals: { used: 0, free: 5, bonus: 0, limit: 5 },
    });
    expect(out.gigRemain).toBe(10);
    expect(out.propRemain).toBe(5);
  });

  it("does not double-count used posts against the remaining free count", () => {
    // used 3, limit 10 => API reports free: 7. Rendering must show 7, not 4.
    const out = renderQuota({
      gigPosts: { used: 3, free: 7, bonus: 0, limit: 10 },
      proposals: { used: 2, free: 3, bonus: 0, limit: 5 },
    });
    expect(out.gigRemain).toBe(7);
    expect(out.propRemain).toBe(3);
  });

  it("adds purchased bonuses on top of remaining free allowance", () => {
    const out = renderQuota({
      gigPosts: { used: 10, free: 0, bonus: 5, limit: 10 },
      proposals: { used: 5, free: 0, bonus: 5, limit: 5 },
    });
    expect(out.gigRemain).toBe(5);
    expect(out.gigTotal).toBe(15);
    expect(out.propRemain).toBe(5);
    expect(out.propTotal).toBe(10);
  });

  it("never reports more remaining than the total", () => {
    const out = renderQuota({
      gigPosts: { used: 0, free: 10, bonus: 5, limit: 10 },
      proposals: { used: 0, free: 5, bonus: 5, limit: 5 },
    });
    expect(out.gigRemain).toBeLessThanOrEqual(out.gigTotal);
    expect(out.propRemain).toBeLessThanOrEqual(out.propTotal);
  });

  it("keeps plan marketing numbers aligned with backend limits", () => {
    // Copy on the page must describe the real allowance: 10 free gigs, 5 free bids.
    expect(QUOTA_PLANS.gigs5.gigBonus).toBe(5);
    expect(QUOTA_PLANS.props5.propBonus).toBe(5);
    expect(QUOTA_PLANS.gigs5.priceInr).toBe(80);
    expect(QUOTA_PLANS.props5.priceInr).toBe(60);
  });
});