import { describe, expect, it } from "vitest";
import { deriveSync, labelForKey } from "./sync";

const base = { configured: true, loading: false, lastOkAt: 1000 };

describe("deriveSync", () => {
  it("reports an unconfigured build honestly", () => {
    const s = deriveSync({ ...base, configured: false, results: {} });
    expect(s.phase).toBe("unconfigured");
    expect(s.message).toMatch(/no AegisMacro contract address/);
    expect(s.lastOkAt).toBeNull();
  });

  it("is loading before any read has completed", () => {
    expect(deriveSync({ ...base, loading: true, results: {} }).phase).toBe("loading");
    expect(deriveSync({ ...base, results: { state: undefined } }).phase).toBe("loading");
  });

  it("is live when every attempted read succeeded", () => {
    const s = deriveSync({ ...base, results: { state: true, risk: true, feeds: true } });
    expect(s.phase).toBe("live");
    expect(s.failedKeys).toEqual([]);
  });

  it("is partial when only some reads failed, and names them", () => {
    const s = deriveSync({ ...base, results: { state: true, risk: false, "position:0xabc": false } });
    expect(s.phase).toBe("partial");
    expect(s.failedKeys).toEqual(["risk", "position:0xabc"]);
    expect(s.message).toMatch(/risk tier/);
    expect(s.message).toMatch(/your lending position/);
  });

  it("is offline when every attempted read failed", () => {
    const s = deriveSync({ ...base, results: { state: false, risk: false } });
    expect(s.phase).toBe("offline");
    expect(s.message).toMatch(/RPC did not answer/);
  });

  it("ignores keys that were never attempted", () => {
    expect(deriveSync({ ...base, results: { state: true, report_count: undefined } }).phase).toBe("live");
  });

  it("a single failed report downgrades live to partial", () => {
    const s = deriveSync({ ...base, results: { state: true, risk: true, "report:3": false } });
    expect(s.phase).toBe("partial");
    expect(s.message).toMatch(/report #3/);
  });

  it("carries the last good read time through", () => {
    expect(deriveSync({ ...base, lastOkAt: 4242, results: { state: false } }).lastOkAt).toBe(4242);
  });
});

describe("labelForKey", () => {
  it.each([
    ["state", "protocol state"],
    ["risk", "risk tier"],
    ["tiers", "tier table"],
    ["feeds", "feed registry"],
    ["report_count", "report count"],
    ["report:12", "report #12"],
    ["position:0xabc", "your lending position"],
    ["watchtower:0xabc", "your Watchtower record"],
    ["something-else", "something-else"],
  ])("%s -> %s", (key, want) => {
    expect(labelForKey(key)).toBe(want);
  });
});
