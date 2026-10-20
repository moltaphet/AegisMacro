import { describe, expect, it } from "vitest";
import { formatDuration, formatGen, formatTimestamp, parseGen, sameAddress, shortAddr, shortHash, toBigInt } from "./format";

describe("toBigInt", () => {
  it.each([
    ["5", 5n],
    [7, 7n],
    [9n, 9n],
    ["", 0n],
    [null, 0n],
    [undefined, 0n],
    ["abc", 0n],
    ["12.5", 0n],
  ])("%s -> %s", (v, want) => {
    expect(toBigInt(v as never)).toBe(want);
  });
});

describe("formatGen", () => {
  it.each([
    ["0", "0"],
    ["1000000000000000000", "1"],
    ["1500000000000000000", "1.5"],
    ["200000000000000000", "0.2"],
    ["1234567890123456789", "1.2345"],
    ["1", "0"],
    ["999999999999999999", "0.9999"],
    ["-2500000000000000000", "-2.5"],
    [10n ** 21n, "1000"],
  ])("formatGen(%s) = %s", (wei, want) => {
    expect(formatGen(wei as never)).toBe(want);
  });

  it("honours the decimal limit and truncates instead of rounding", () => {
    expect(formatGen("1999999999999999999", 2)).toBe("1.99");
    expect(formatGen("1999999999999999999", 6)).toBe("1.999999");
    expect(formatGen("1999999999999999999", 0)).toBe("1");
  });

  it("treats null / garbage as zero", () => {
    expect(formatGen(null)).toBe("0");
    expect(formatGen(undefined)).toBe("0");
    expect(formatGen("zzz")).toBe("0");
  });
});

describe("parseGen", () => {
  it.each([
    ["1", 10n ** 18n],
    ["0.2", 2n * 10n ** 17n],
    [".5", 5n * 10n ** 17n],
    ["10.000000000000000001", 10n * 10n ** 18n + 1n],
    ["0", 0n],
    ["  3  ", 3n * 10n ** 18n],
    ["0.000000000000000001", 1n],
  ])("accepts %j", (s, want) => {
    expect(parseGen(s)).toBe(want);
  });

  it.each(["", "abc", "-1", "+1", "1e18", "1.2.3", "0x10", "1,5", "1.0000000000000000001", ".", "1.", " ", "1 000"])("rejects %j", (s) => {
    expect(parseGen(s)).toBeNull();
  });

  it("round-trips with formatGen", () => {
    for (const s of ["1", "0.2", "12.3456", "0.0001"]) {
      expect(formatGen(parseGen(s) as bigint, 18)).toBe(s);
    }
  });
});

describe("address + hash helpers", () => {
  it("shortens long addresses", () => {
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
  it("leaves short strings alone and handles empty", () => {
    expect(shortAddr("0x12")).toBe("0x12");
    expect(shortAddr(null)).toBe("-");
    expect(shortAddr("")).toBe("-");
  });
  it("shortens hashes", () => {
    expect(shortHash("0x" + "ab".repeat(32))).toBe("0xabababab…ababab");
    expect(shortHash("0xabc")).toBe("0xabc");
    expect(shortHash(undefined)).toBe("-");
  });
  it.each([
    ["0xABC", "0xabc", true],
    ["0xabc", "0xabd", false],
    [null, "0xabc", false],
    ["0xabc", undefined, false],
    ["", "", false],
  ])("sameAddress(%s, %s) = %s", (a, b, want) => {
    expect(sameAddress(a, b)).toBe(want);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [-5, "0s"],
    [NaN, "0s"],
    [45, "45s"],
    [120, "2m"],
    [3 * 3600 + 5 * 60, "3h 5m"],
    [2 * 86400 + 4 * 3600, "2d 4h"],
    [7 * 86400, "7d 0h"],
  ])("%s -> %s", (s, want) => {
    expect(formatDuration(s)).toBe(want);
  });
});

describe("formatTimestamp", () => {
  it("formats unix seconds as UTC", () => {
    expect(formatTimestamp(1790812800)).toBe("2026-10-01 00:00:00 UTC");
  });
  it("shows a dash for zero", () => {
    expect(formatTimestamp(0)).toBe("-");
  });
});
