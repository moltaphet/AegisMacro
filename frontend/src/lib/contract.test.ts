import { describe, expect, it, vi } from "vitest";
import { normalizeCalldata, parseChainId, watchWallet, type Eip1193Provider } from "./contract";
import { explorerAddressUrl, explorerTxUrl, isConfigured, ZERO_ADDRESS } from "./config";

describe("normalizeCalldata", () => {
  it("turns small bigints into numbers", () => {
    expect(normalizeCalldata(5n)).toBe(5);
    expect(normalizeCalldata(-3n)).toBe(-3);
  });
  it("keeps huge bigints exact as strings", () => {
    expect(normalizeCalldata(10n ** 30n)).toBe("1000000000000000000000000000000");
  });
  it("converts Maps (recursively) to plain objects", () => {
    const m = new Map<string, unknown>([
      ["a", 1n],
      ["b", new Map([["c", "x"]])],
    ]);
    expect(normalizeCalldata(m)).toEqual({ a: 1, b: { c: "x" } });
  });
  it("maps arrays element-wise", () => {
    expect(normalizeCalldata([1n, new Map([["k", 2n]])])).toEqual([1, { k: 2 }]);
  });
  it("renders bytes as hex", () => {
    expect(normalizeCalldata(new Uint8Array([1, 255]))).toBe("0x01ff");
  });
  it.each([["s"], [true], [null], [undefined]])("passes %s through", (v) => {
    expect(normalizeCalldata(v)).toBe(v);
  });
});

describe("parseChainId", () => {
  it.each([
    ["0xf22d", 61997],
    ["61997", 61997],
    [61997, 61997],
    ["0x1", 1],
  ])("%s -> %s", (raw, want) => {
    expect(parseChainId(raw)).toBe(want);
  });
  it.each(["", "abc", "0xzz", null, undefined, {}, NaN])("rejects %s", (raw) => {
    expect(parseChainId(raw)).toBeNull();
  });
});

describe("watchWallet", () => {
  function fake() {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const provider: Eip1193Provider = {
      request: vi.fn(async () => null),
      on: (e, h) => void handlers.set(e, h),
      removeListener: (e, h) => {
        if (handlers.get(e) === h) handlers.delete(e);
      },
    };
    return { provider, handlers };
  }

  it("forwards accountsChanged and chainChanged", () => {
    const { provider, handlers } = fake();
    const onA = vi.fn();
    const onC = vi.fn();
    watchWallet(provider, onA, onC);
    handlers.get("accountsChanged")?.(["0xabc"]);
    handlers.get("chainChanged")?.("0xf22d");
    expect(onA).toHaveBeenCalledWith(["0xabc"]);
    expect(onC).toHaveBeenCalledWith(61997);
  });

  it("treats a malformed accountsChanged payload as disconnected", () => {
    const { provider, handlers } = fake();
    const onA = vi.fn();
    watchWallet(provider, onA, vi.fn());
    handlers.get("accountsChanged")?.("oops");
    expect(onA).toHaveBeenCalledWith([]);
  });

  it("unsubscribes cleanly", () => {
    const { provider, handlers } = fake();
    const off = watchWallet(provider, vi.fn(), vi.fn());
    expect(handlers.size).toBe(2);
    off();
    expect(handlers.size).toBe(0);
  });

  it("tolerates providers without event support", () => {
    const provider: Eip1193Provider = { request: async () => null };
    expect(() => watchWallet(provider, vi.fn(), vi.fn())()).not.toThrow();
  });
});

describe("config helpers", () => {
  it("rejects the zero address and junk", () => {
    expect(isConfigured(ZERO_ADDRESS)).toBe(false);
    expect(isConfigured("0x123")).toBe(false);
    expect(isConfigured("not an address")).toBe(false);
  });
  it("accepts a real-looking address", () => {
    expect(isConfigured("0x" + "ab".repeat(20))).toBe(true);
  });
  it("builds explorer links", () => {
    expect(explorerAddressUrl("0xabc")).toBe("https://explorer-studio-next.genlayer.com/address/0xabc");
    expect(explorerTxUrl("0xdef")).toBe("https://explorer-studio-next.genlayer.com/tx/0xdef");
  });
});
