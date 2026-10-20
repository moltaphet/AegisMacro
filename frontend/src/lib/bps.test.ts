import { describe, expect, it } from "vitest";
import {
  ATTO,
  BOUNTY_BPS,
  INDEX_ONE,
  MIN_WATCHTOWER_BOND,
  SECONDS_PER_YEAR,
  TIERS,
  bountyFor,
  bpsToPercent,
  debtAfter,
  headroomBps,
  indexAfter,
  ltvBps,
  maxDebt,
  projectDebt,
  reserveCut,
  splitRepayment,
  tierOf,
  withinLtv,
} from "./bps";

describe("tier table", () => {
  it.each([
    [0, 8000n, 400n, 1000n],
    [1, 7000n, 750n, 2000n],
    [2, 5000n, 1200n, 4000n],
  ])("tier %i binds %i / %i / %i bps", (level, ltv, rate, rf) => {
    const t = tierOf(level);
    expect([t.maxLtvBps, t.borrowRateBps, t.reserveFactorBps]).toEqual([ltv, rate, rf]);
  });

  it.each([-1, 3, 99, NaN])("unknown level %s falls back to NORMAL", (level) => {
    expect(tierOf(level).level).toBe(0);
  });

  it("tightens monotonically as risk rises", () => {
    expect(TIERS[0].maxLtvBps > TIERS[1].maxLtvBps && TIERS[1].maxLtvBps > TIERS[2].maxLtvBps).toBe(true);
    expect(TIERS[0].borrowRateBps < TIERS[1].borrowRateBps && TIERS[1].borrowRateBps < TIERS[2].borrowRateBps).toBe(true);
    expect(TIERS[0].reserveFactorBps < TIERS[1].reserveFactorBps && TIERS[1].reserveFactorBps < TIERS[2].reserveFactorBps).toBe(true);
  });

  it("keeps every parameter inside 0..10000 bps", () => {
    for (const t of TIERS) {
      for (const v of [t.maxLtvBps, t.borrowRateBps, t.reserveFactorBps]) {
        expect(v > 0n && v <= 10_000n).toBe(true);
      }
    }
  });

  it("names match the contract", () => {
    expect(TIERS.map((t) => t.name)).toEqual(["RISK_LEVEL_NORMAL", "RISK_LEVEL_ELEVATED", "RISK_LEVEL_CRITICAL"]);
  });
});

describe("maxDebt / withinLtv", () => {
  it.each([
    [10n * ATTO, 8000n, 8n * ATTO],
    [10n * ATTO, 7000n, 7n * ATTO],
    [10n * ATTO, 5000n, 5n * ATTO],
    [3n, 8000n, 2n],
    [1n, 8000n, 0n],
    [0n, 8000n, 0n],
  ])("maxDebt(%s, %s) = %s", (c, ltv, want) => {
    expect(maxDebt(c, ltv)).toBe(want);
  });

  it.each([
    [8n * ATTO, 10n * ATTO, 8000n, true],
    [8n * ATTO + 1n, 10n * ATTO, 8000n, false],
    [5n * ATTO, 10n * ATTO, 5000n, true],
    [5n * ATTO + 1n, 10n * ATTO, 5000n, false],
    [0n, 0n, 8000n, true],
    [1n, 0n, 8000n, false],
    [2n, 3n, 8000n, true],
    [3n, 3n, 8000n, false],
  ])("withinLtv(debt=%s, coll=%s, %s) = %s", (debt, coll, ltv, want) => {
    expect(withinLtv(debt, coll, ltv)).toBe(want);
  });

  it("agrees with maxDebt at every boundary", () => {
    for (const c of [1n, 2n, 3n, 7n, 13n, 101n, 9999n, 10_001n, 10n * ATTO + 7n]) {
      for (const t of TIERS) {
        const m = maxDebt(c, t.maxLtvBps);
        expect(withinLtv(m, c, t.maxLtvBps)).toBe(true);
        expect(withinLtv(m + 1n, c, t.maxLtvBps)).toBe(false);
      }
    }
  });
});

describe("ltvBps / headroomBps", () => {
  it.each([
    [0n, 0n, 0n],
    [5n, 0n, 0n],
    [4n * ATTO, 10n * ATTO, 4000n],
    [1n, 3n, 3333n],
    [10n * ATTO, 10n * ATTO, 10_000n],
  ])("ltvBps(%s, %s) = %s", (d, c, want) => {
    expect(ltvBps(d, c)).toBe(want);
  });

  it.each([
    [4n * ATTO, 10n * ATTO, 8000n, 4000n],
    [8n * ATTO, 10n * ATTO, 8000n, 0n],
    [9n * ATTO, 10n * ATTO, 8000n, 0n],
    [0n, 10n * ATTO, 5000n, 5000n],
  ])("headroom(%s, %s, %s) = %s", (d, c, m, want) => {
    expect(headroomBps(d, c, m)).toBe(want);
  });
});

describe("interest accrual", () => {
  it.each([
    [400n, 104n],
    [750n, 107n],
    [1200n, 112n],
  ])("one year at %s bps scales the index", (rate) => {
    expect(indexAfter(INDEX_ONE, rate, SECONDS_PER_YEAR)).toBe(INDEX_ONE + (INDEX_ONE * rate) / 10_000n);
  });

  it("does not move for zero or negative elapsed time", () => {
    expect(indexAfter(INDEX_ONE, 400n, 0n)).toBe(INDEX_ONE);
    expect(indexAfter(INDEX_ONE, 400n, -5n)).toBe(INDEX_ONE);
  });

  it.each(TIERS.map((t) => [t.short, t.borrowRateBps] as const))("projectDebt over a year at %s equals principal*(1+rate)", (_, rate) => {
    expect(projectDebt(ATTO, rate, SECONDS_PER_YEAR)).toBe(ATTO + (ATTO * rate) / 10_000n);
  });

  it("rounds debt up, never down", () => {
    expect(debtAfter(3n, 10n, 11n)).toBe(4n); // 3.3 -> 4
    expect(debtAfter(10n, 10n, 11n)).toBe(11n);
    expect(debtAfter(1n, 3n, 4n)).toBe(2n); // 1.33 -> 2
  });

  it("passes debt through when nothing changed", () => {
    expect(debtAfter(0n, 1n, 5n)).toBe(0n);
    expect(debtAfter(7n, 0n, 5n)).toBe(7n);
    expect(debtAfter(7n, 5n, 5n)).toBe(7n);
  });

  it("compounds half-year segments at different tiers like the contract", () => {
    const half = SECONDS_PER_YEAR / 2n;
    const i1 = indexAfter(INDEX_ONE, 400n, half);
    const i2 = indexAfter(i1, 1200n, half);
    expect(i1).toBe(INDEX_ONE + (INDEX_ONE * 400n * half) / (10_000n * SECONDS_PER_YEAR));
    expect(debtAfter(ATTO, INDEX_ONE, i2)).toBe((ATTO * i2 + INDEX_ONE - 1n) / INDEX_ONE);
  });
});

describe("reserve + bounty", () => {
  it.each([
    [4n * 10n ** 16n, 1000n, 4n * 10n ** 15n],
    [75n * 10n ** 15n, 2000n, 15n * 10n ** 15n],
    [12n * 10n ** 16n, 4000n, 48n * 10n ** 15n],
    [9n, 1000n, 0n],
    [10n, 1000n, 1n],
  ])("reserveCut(%s, %s) = %s", (interest, rf, want) => {
    expect(reserveCut(interest, rf)).toBe(want);
  });

  it("bounty is 10% of the bond when the pool is deep", () => {
    expect(BOUNTY_BPS).toBe(1000n);
    expect(bountyFor(MIN_WATCHTOWER_BOND, ATTO)).toBe(MIN_WATCHTOWER_BOND / 10n);
  });

  it("bounty is capped by the reserve pool", () => {
    expect(bountyFor(MIN_WATCHTOWER_BOND, 5n)).toBe(5n);
    expect(bountyFor(MIN_WATCHTOWER_BOND, 0n)).toBe(0n);
  });

  it("bounty is always below the bond", () => {
    for (const bond of [MIN_WATCHTOWER_BOND, ATTO, 7n * ATTO]) expect(bountyFor(bond, 100n * ATTO) < bond).toBe(true);
  });

  it("minimum bond is 0.2 GEN", () => {
    expect(MIN_WATCHTOWER_BOND).toBe(200_000_000_000_000_000n);
  });
});

describe("splitRepayment", () => {
  it.each([
    [50n, 100n, 80n, { interest: 20n, principal: 30n, paid: 50n, refund: 0n }],
    [10n, 100n, 80n, { interest: 10n, principal: 0n, paid: 10n, refund: 0n }],
    [100n, 100n, 80n, { interest: 20n, principal: 80n, paid: 100n, refund: 0n }],
    [150n, 100n, 80n, { interest: 20n, principal: 80n, paid: 100n, refund: 50n }],
    [5n, 100n, 100n, { interest: 0n, principal: 5n, paid: 5n, refund: 0n }],
    [0n, 100n, 80n, { interest: 0n, principal: 0n, paid: 0n, refund: 0n }],
  ])("pay %s against debt %s / principal %s", (pay, debt, principal, want) => {
    expect(splitRepayment(pay, debt, principal)).toEqual(want);
  });

  it("conserves every wei sent", () => {
    for (const pay of [0n, 1n, 17n, 99n, 100n, 250n]) {
      const r = splitRepayment(pay, 100n, 60n);
      expect(r.interest + r.principal + r.refund).toBe(pay);
    }
  });
});

describe("bpsToPercent", () => {
  it.each([
    [750, "7.50"],
    [8000, "80.00"],
    [5, "0.05"],
    [0, "0.00"],
    [10_000, "100.00"],
    [12_345, "123.45"],
    [400n, "4.00"],
  ])("%s -> %s", (bps, want) => {
    expect(bpsToPercent(bps)).toBe(want);
  });
});
