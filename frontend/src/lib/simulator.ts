// Pure LTV / health simulator. Every figure is bigint basis-point math taken
// from bps.ts, i.e. the same integer rules the contract enforces.

import { SECONDS_PER_YEAR, TIERS, ltvBps, maxDebt, projectDebt, reserveCut, withinLtv, type TierParams } from "./bps";

export interface TierSim {
  tier: TierParams;
  maxBorrow: bigint;
  currentLtvBps: bigint;
  allowed: boolean;
  /** Share of the limit already used, in whole percent (can exceed 100). */
  utilizationPct: number;
  interestOneYear: bigint;
  reserveOneYear: bigint;
  /** Extra collateral needed to make the position allowed (0 when it already is). */
  collateralShortfall: bigint;
}

export function simulate(collateral: bigint, borrow: bigint): TierSim[] {
  return TIERS.map((tier) => {
    const limit = maxDebt(collateral, tier.maxLtvBps);
    const used = ltvBps(borrow, collateral);
    const allowed = withinLtv(borrow, collateral, tier.maxLtvBps);
    const utilizationPct = tier.maxLtvBps === 0n ? 0 : Number((used * 100n) / tier.maxLtvBps);
    const interest = projectDebt(borrow, tier.borrowRateBps, SECONDS_PER_YEAR) - borrow;
    // smallest collateral c with borrow*10000 <= c*ltv  ->  c = ceil(borrow*10000/ltv)
    const need = (borrow * 10_000n + tier.maxLtvBps - 1n) / tier.maxLtvBps;
    return {
      tier,
      maxBorrow: limit,
      currentLtvBps: used,
      allowed,
      utilizationPct,
      interestOneYear: interest,
      reserveOneYear: reserveCut(interest, tier.reserveFactorBps),
      collateralShortfall: allowed || need <= collateral ? 0n : need - collateral,
    };
  });
}

export type Health = "safe" | "tight" | "over";

/** safe < 80% of limit used, tight 80-100%, over beyond the limit. */
export function healthOf(sim: TierSim): Health {
  if (!sim.allowed) return "over";
  return sim.utilizationPct >= 80 ? "tight" : "safe";
}
