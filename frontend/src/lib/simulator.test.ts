import { describe, expect, it } from "vitest";
import { ATTO } from "./bps";
import { healthOf, simulate } from "./simulator";

describe("simulate", () => {
  it("returns one row per tier in order", () => {
    expect(simulate(10n * ATTO, 0n).map((s) => s.tier.short)).toEqual(["NORMAL", "ELEVATED", "CRITICAL"]);
  });

  it.each([
    [10n * ATTO, [8n * ATTO, 7n * ATTO, 5n * ATTO]],
    [3n, [2n, 2n, 1n]],
    [1n, [0n, 0n, 0n]],
  ])("max borrow for collateral %s", (c, want) => {
    expect(simulate(c, 0n).map((s) => s.maxBorrow)).toEqual(want);
  });

  it.each([
    [5n * ATTO, [true, true, true]],
    [6n * ATTO, [true, true, false]],
    [7n * ATTO, [true, true, false]],
    [7n * ATTO + 1n, [true, false, false]],
    [8n * ATTO, [true, false, false]],
    [8n * ATTO + 1n, [false, false, false]],
  ])("allowed flags at borrow %s with 10 GEN collateral", (b, want) => {
    expect(simulate(10n * ATTO, b).map((s) => s.allowed)).toEqual(want);
  });

  it("computes one-year interest and the reserve cut per tier", () => {
    const [n, e, c] = simulate(10n * ATTO, ATTO);
    expect(n.interestOneYear).toBe(4n * 10n ** 16n);
    expect(e.interestOneYear).toBe(75n * 10n ** 15n);
    expect(c.interestOneYear).toBe(12n * 10n ** 16n);
    expect(n.reserveOneYear).toBe(4n * 10n ** 15n);
    expect(e.reserveOneYear).toBe(15n * 10n ** 15n);
    expect(c.reserveOneYear).toBe(48n * 10n ** 15n);
  });

  it("reports the extra collateral needed to fit a tier", () => {
    const [n, e, c] = simulate(10n * ATTO, 8n * ATTO + ATTO / 2n);
    expect(n.collateralShortfall > 0n).toBe(true);
    // adding the shortfall makes the position exactly allowed
    expect(simulate(10n * ATTO + n.collateralShortfall, 8n * ATTO + ATTO / 2n)[0].allowed).toBe(true);
    expect(simulate(10n * ATTO + n.collateralShortfall - 1n, 8n * ATTO + ATTO / 2n)[0].allowed).toBe(false);
    expect(e.collateralShortfall > n.collateralShortfall).toBe(true);
    expect(c.collateralShortfall > e.collateralShortfall).toBe(true);
  });

  it("no shortfall when the position already fits", () => {
    expect(simulate(10n * ATTO, ATTO).every((s) => s.collateralShortfall === 0n)).toBe(true);
  });

  it("utilisation scales with how much of the limit is used", () => {
    expect(simulate(10n * ATTO, 4n * ATTO)[0].utilizationPct).toBe(50);
    expect(simulate(10n * ATTO, 8n * ATTO)[0].utilizationPct).toBe(100);
    expect(simulate(10n * ATTO, 0n)[0].utilizationPct).toBe(0);
  });
});

describe("healthOf", () => {
  it("classifies safe / tight / over", () => {
    expect(healthOf(simulate(10n * ATTO, ATTO)[0])).toBe("safe");
    expect(healthOf(simulate(10n * ATTO, 7n * ATTO)[0])).toBe("tight");
    expect(healthOf(simulate(10n * ATTO, 9n * ATTO)[0])).toBe("over");
  });

  it("the same position is safer under a looser tier", () => {
    const rows = simulate(10n * ATTO, 6n * ATTO);
    expect(rows.map(healthOf)).toEqual(["safe", "tight", "over"]);
  });
});
