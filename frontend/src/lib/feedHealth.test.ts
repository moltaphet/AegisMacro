import { describe, expect, it } from "vitest";
import { lastReportHealth, rotationCountdown, slotHealth } from "./feedHealth";
import type { FeedSource, ReportRecord } from "./types";

const feed = (over: Partial<FeedSource> = {}): FeedSource => ({
  slot: 0,
  label: "X",
  host: "h",
  base_url: "u",
  operator: "o",
  pending_base_url: "",
  pending_operator: "",
  rotation_eta: 0,
  ...over,
});

describe("slotHealth", () => {
  it("is unknown until the registry loads", () => {
    expect(slotHealth(undefined, false)).toBe("unknown");
    expect(slotHealth(feed(), false)).toBe("unknown");
    expect(slotHealth(undefined, true)).toBe("unknown");
  });
  it("is ok for a settled slot", () => {
    expect(slotHealth(feed(), true)).toBe("ok");
  });
  it("is degraded while a rotation is pending", () => {
    expect(slotHealth(feed({ rotation_eta: 123 }), true)).toBe("degraded");
  });
});

describe("rotationCountdown", () => {
  it.each([
    [1000, 400, 600],
    [1000, 1000, 0],
    [1000, 2000, 0],
  ])("eta %s now %s -> %s", (eta, now, want) => {
    expect(rotationCountdown(eta, now)).toBe(want);
  });
});

describe("lastReportHealth", () => {
  const rep = (n: number) => ({ source_count: n }) as ReportRecord;
  it.each([
    [3, "ok"],
    [2, "degraded"],
    [1, "down"],
    [0, "down"],
  ])("%s sources -> %s", (n, want) => {
    expect(lastReportHealth(rep(n))).toBe(want);
  });
  it("is unknown with no report", () => {
    expect(lastReportHealth(undefined)).toBe("unknown");
  });
});
