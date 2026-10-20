// Integer basis-point math, mirroring contracts/aegis_macro.py exactly.
// bigint throughout: there is no floating point anywhere in this module.

import type { RiskLevel } from "./types";

export const BPS = 10_000n;
export const SECONDS_PER_YEAR = 31_536_000n;
export const INDEX_ONE = 10n ** 18n;
export const ATTO = 10n ** 18n;
export const BOUNTY_BPS = 1_000n;
export const MIN_WATCHTOWER_BOND = ATTO / 5n;

export interface TierParams {
  level: RiskLevel;
  name: string;
  short: string;
  maxLtvBps: bigint;
  borrowRateBps: bigint;
  reserveFactorBps: bigint;
}

export const TIERS: readonly [TierParams, TierParams, TierParams] = [
  { level: 0, name: "RISK_LEVEL_NORMAL", short: "NORMAL", maxLtvBps: 8000n, borrowRateBps: 400n, reserveFactorBps: 1000n },
  { level: 1, name: "RISK_LEVEL_ELEVATED", short: "ELEVATED", maxLtvBps: 7000n, borrowRateBps: 750n, reserveFactorBps: 2000n },
  { level: 2, name: "RISK_LEVEL_CRITICAL", short: "CRITICAL", maxLtvBps: 5000n, borrowRateBps: 1200n, reserveFactorBps: 4000n },
];

export function tierOf(level: number): TierParams {
  const t = TIERS[level as RiskLevel];
  return t ?? TIERS[0];
}

/** Largest debt allowed against `collateral` at `ltvBps` (floor). */
export function maxDebt(collateral: bigint, ltvBps: bigint): bigint {
  return (collateral * ltvBps) / BPS;
}

/** The contract's exact acceptance test: debt/collateral <= ltv/10000. */
export function withinLtv(debt: bigint, collateral: bigint, ltvBps: bigint): boolean {
  return debt * BPS <= collateral * ltvBps;
}

/** Current LTV in whole basis points (floor); 0 with no collateral. */
export function ltvBps(debt: bigint, collateral: bigint): bigint {
  return collateral === 0n ? 0n : (debt * BPS) / collateral;
}

/** Headroom before the limit, in basis points of collateral (never negative). */
export function headroomBps(debt: bigint, collateral: bigint, maxLtv: bigint): bigint {
  const used = ltvBps(debt, collateral);
  return used >= maxLtv ? 0n : maxLtv - used;
}

/** Index growth over `seconds` at `rateBps`, the contract's formula. */
export function indexAfter(index: bigint, rateBps: bigint, seconds: bigint): bigint {
  if (seconds <= 0n) return index;
  return index + (index * rateBps * seconds) / (BPS * SECONDS_PER_YEAR);
}

/** Debt after accrual, rounded UP like the contract. */
export function debtAfter(debt: bigint, fromIndex: bigint, toIndex: bigint): bigint {
  if (debt === 0n || fromIndex === 0n || fromIndex === toIndex) return debt;
  return (debt * toIndex + fromIndex - 1n) / fromIndex;
}

/** Projected debt after `seconds` at `rateBps`. */
export function projectDebt(debt: bigint, rateBps: bigint, seconds: bigint): bigint {
  return debtAfter(debt, INDEX_ONE, indexAfter(INDEX_ONE, rateBps, seconds));
}

export function reserveCut(interestPaid: bigint, reserveFactorBps: bigint): bigint {
  return (interestPaid * reserveFactorBps) / BPS;
}

export function bountyFor(bond: bigint, reservePool: bigint): bigint {
  const want = (bond * BOUNTY_BPS) / BPS;
  return want < reservePool ? want : reservePool;
}

/** Split a repayment into interest-first then principal, like repay(). */
export function splitRepayment(
  pay: bigint,
  debt: bigint,
  principal: bigint,
): { interest: bigint; principal: bigint; paid: bigint; refund: bigint } {
  const paid = pay < debt ? pay : debt;
  const interestOwed = debt > principal ? debt - principal : 0n;
  const interest = paid < interestOwed ? paid : interestOwed;
  return { interest, principal: paid - interest, paid, refund: pay - paid };
}

/** Whole-percent display of a bps value without floats: 750 -> "7.50". */
export function bpsToPercent(bps: bigint | number): string {
  const v = BigInt(bps);
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}
