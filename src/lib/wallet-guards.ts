/**
 * Wallet-protection rules for project bids and community gig orders.
 *
 * Two separate guarantees live here:
 *
 *  1. Project escrow. When a client accepts a bid the agreed amount is HELD in
 *     their wallet immediately, so they cannot also commit the same money to
 *     another bid. release-payment then credits the seller without deducting a
 *     second time, and cancelling the project refunds the client. Projects
 *     accepted before escrow existed hold nothing, so release still deducts
 *     for them — that is what keeps old projects paid correctly.
 *
 *  2. Community gig orders. A client can only order a gig if their wallet can
 *     cover it. The amount checked must be exactly the amount stored, so the
 *     two are resolved by one function rather than recomputed in two places.
 */

/** True when the project's agreed amount is already held from the client. */
export function isEscrowHeld(project: { escrowHeldAt?: Date | string | null; escrowAmount?: number | string | null }): boolean {
  if (!project.escrowHeldAt) return false;
  return Number(project.escrowAmount || 0) > 0;
}

/** Amount to refund a client when an escrowed project is cancelled. */
export function escrowRefundAmount(project: { escrowHeldAt?: Date | string | null; escrowAmount?: number | string | null }): number {
  return isEscrowHeld(project) ? Number(project.escrowAmount) : 0;
}

/**
 * The price a client must be able to afford to order this post.
 *  - GIG     -> the price fixed on the post; falls back to the quoted amount.
 *  - BARTER  -> nothing (a barter trades skills, it does not cost money).
 *  - PROJECT -> the amount being quoted as a bid (checked elsewhere).
 * Returns null when no balance check applies.
 */
export function resolveGigAmount(kind: string, priceInr: number | string | null | undefined, amount: unknown): number | null {
  if (kind === "BARTER") return null;
  if (kind === "GIG") {
    const fixed = Number(priceInr);
    if (Number.isFinite(fixed) && fixed > 0) return Math.round(fixed);
    const quoted = Number(amount);
    if (Number.isFinite(quoted) && quoted > 0) return Math.round(quoted);
    return null;
  }
  const bid = Number(amount);
  return Number.isFinite(bid) && bid > 0 ? Math.round(bid) : null;
}

/** True when the wallet can cover `price`. */
export function canAfford(balance: number | string | null | undefined, price: number): boolean {
  return Number(balance || 0) >= price;
}
