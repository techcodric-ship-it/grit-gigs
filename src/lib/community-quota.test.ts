import { describe, it, expect } from "vitest";

// community-quota imports the db module, which validates DATABASE_URL at load
// time. A dummy value is enough: nothing under test opens a connection. This
// must be set before the dynamic import below.
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const { QUOTA_PLANS, planForAmount } = await import("./community-quota");

describe("planForAmount", () => {
  it("resolves the gigs bundle by price", () => {
    expect(planForAmount(80)?.id).toBe("gigs5");
  });

  it("resolves the proposals bundle by price", () => {
    expect(planForAmount(60)?.id).toBe("props5");
  });

  it("returns null for a price that is not a bundle", () => {
    expect(planForAmount(500)).toBeNull();
    expect(planForAmount(0)).toBeNull();
  });

  it("round-trips every plan, so recovery can never mis-credit a bundle", () => {
    for (const plan of Object.values(QUOTA_PLANS)) {
      expect(planForAmount(plan.priceInr)?.id).toBe(plan.id);
    }
  });
});

describe("quota bundle plans", () => {
  it("grants 5 gigs for the gigs bundle", () => {
    expect(QUOTA_PLANS.gigs5).toMatchObject({ gigBonus: 5, propBonus: 0, priceInr: 80 });
  });

  it("grants 5 proposals for the props bundle", () => {
    expect(QUOTA_PLANS.props5).toMatchObject({ gigBonus: 0, propBonus: 5, priceInr: 60 });
  });

  it("keeps plan prices unique so amount lookup is unambiguous", () => {
    const prices = Object.values(QUOTA_PLANS).map((p) => p.priceInr);
    expect(new Set(prices).size).toBe(prices.length);
  });
});