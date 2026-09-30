import { describe, it, expect } from "vitest";
import { isEscrowHeld, escrowRefundAmount, resolveGigAmount, canAfford } from "./wallet-guards";

describe("project escrow", () => {
  it("treats a project as escrowed only when both fields are set", () => {
    expect(isEscrowHeld({ escrowHeldAt: new Date(), escrowAmount: 5000 })).toBe(true);
    expect(isEscrowHeld({ escrowHeldAt: null, escrowAmount: 5000 })).toBe(false);
    expect(isEscrowHeld({ escrowHeldAt: new Date(), escrowAmount: 0 })).toBe(false);
    expect(isEscrowHeld({})).toBe(false);
  });

  it("refunds only what was actually held", () => {
    expect(escrowRefundAmount({ escrowHeldAt: new Date(), escrowAmount: 7500 })).toBe(7500);
    // Legacy project accepted before escrow: nothing held, so nothing to refund.
    expect(escrowRefundAmount({ escrowHeldAt: null, escrowAmount: 0 })).toBe(0);
  });

  it("reads numeric columns that arrive as strings from postgres", () => {
    expect(isEscrowHeld({ escrowHeldAt: "2026-01-01T00:00:00Z", escrowAmount: "2500" })).toBe(true);
    expect(escrowRefundAmount({ escrowHeldAt: "2026-01-01T00:00:00Z", escrowAmount: "2500" })).toBe(2500);
  });
});

describe("community gig ordering", () => {
  it("uses the price fixed on a gig post and ignores the client's quoted amount", () => {
    // A client must not be able to lower the amount they are checked against.
    expect(resolveGigAmount("GIG", 5000, 1)).toBe(5000);
    expect(resolveGigAmount("GIG", 5000, 999999)).toBe(5000);
  });

  it("falls back to the quoted amount when the post carries no price", () => {
    expect(resolveGigAmount("GIG", null, 2500.4)).toBe(2500);
    expect(resolveGigAmount("GIG", null, 0)).toBeNull();
    expect(resolveGigAmount("GIG", null, -100)).toBeNull();
    expect(resolveGigAmount("GIG", null, "abc")).toBeNull();
  });

  it("never asks a client to pay for a barter", () => {
    expect(resolveGigAmount("BARTER", 5000, 5000)).toBeNull();
  });

  it("checks the quoted bid amount for project proposals", () => {
    expect(resolveGigAmount("PROJECT", 12000, 3000)).toBe(3000);
    expect(resolveGigAmount("PROJECT", 12000, 0)).toBeNull();
  });

  it("blocks a client whose balance is short and allows one who can cover it", () => {
    expect(canAfford(4999, 5000)).toBe(false);
    expect(canAfford(5000, 5000)).toBe(true);
    expect(canAfford(5001, 5000)).toBe(true);
  });

  it("treats a missing wallet row as zero balance", () => {
    expect(canAfford(null, 1)).toBe(false);
    expect(canAfford(undefined, 1)).toBe(false);
  });
});
