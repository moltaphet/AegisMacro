import { describe, expect, it, vi } from "vitest";
import { AccountScope, PUBLIC_KEYS, accountKeys, createAccountLoader, createPublicLoader, loadRecentReports, type ChainReader } from "./stores";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function reader(handlers: Record<string, (args: unknown[]) => unknown>): ChainReader & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  return {
    calls,
    async view(method: string, args: unknown[] = []) {
      calls.push([method, args]);
      const h = handlers[method];
      if (!h) throw new Error(`no handler ${method}`);
      return h(args) as never;
    },
  };
}

describe("accountKeys", () => {
  it("builds lower-cased, address-embedded keys", () => {
    expect(accountKeys("0xABCDEF")).toEqual(["position:0xabcdef", "watchtower:0xabcdef"]);
  });
});

describe("public loader", () => {
  it.each([
    ["state", "get_protocol_state"],
    ["risk", "get_risk_status"],
    ["tiers", "get_risk_tiers"],
    ["feeds", "get_feed_sources"],
    ["report_count", "get_report_count"],
  ])("key %s reads %s", async (key, method) => {
    const r = reader({ [method]: () => ({ ok: key }) });
    const l = createPublicLoader(r);
    expect((await l.load(key)).value).toEqual({ ok: key });
    expect(r.calls[0][0]).toBe(method);
  });

  it("report:N passes the report id as a number", async () => {
    const r = reader({ get_report: (a) => ({ id: a[0] }) });
    const l = createPublicLoader(r);
    expect((await l.load("report:7")).value).toEqual({ id: 7 });
    expect(r.calls[0][1]).toEqual([7]);
  });

  it("rejects unknown keys as a recorded failure", async () => {
    const l = createPublicLoader(reader({}));
    expect((await l.load("mystery")).error).toMatch(/unknown public key/);
  });

  it("the key list is the four panels the page needs", () => {
    expect([...PUBLIC_KEYS]).toEqual(["state", "risk", "tiers", "feeds"]);
  });
});

describe("account loader", () => {
  it("reads the position and Watchtower record for the embedded address", async () => {
    const r = reader({ get_position: (a) => ({ who: a[0] }), get_watchtower: (a) => ({ who: a[0] }) });
    const l = createAccountLoader(r);
    expect((await l.load(`position:${A}`)).value).toEqual({ who: A });
    expect((await l.load(`watchtower:${B}`)).value).toEqual({ who: B });
  });
  it("rejects unknown keys", async () => {
    const l = createAccountLoader(reader({}));
    expect((await l.load("nope")).error).toMatch(/unknown account key/);
  });
});

describe("AccountScope", () => {
  const make = () => {
    const r = reader({
      get_position: (a) => ({ owner: a[0] }),
      get_watchtower: (a) => ({ address: a[0] }),
    });
    return new AccountScope(createAccountLoader(r));
  };

  it("starts with no account and reads nothing", () => {
    const s = make();
    expect(s.account).toBeNull();
    expect(s.read("position")).toEqual({ stale: false });
  });

  it("setAccount reports a change once", () => {
    const s = make();
    expect(s.setAccount(A)).toBe(true);
    expect(s.setAccount(A)).toBe(false);
    expect(s.setAccount(A.toUpperCase().replace("0X", "0x"))).toBe(false);
    expect(s.setAccount(B)).toBe(true);
  });

  it("normalises the account to lower case", () => {
    const s = make();
    s.setAccount("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD");
    expect(s.account).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });

  it("refresh loads both account panels", async () => {
    const s = make();
    s.setAccount(A);
    await s.refresh();
    expect(s.read<{ owner: string }>("position").value?.owner).toBe(A);
    expect(s.read<{ address: string }>("watchtower").value?.address).toBe(A);
  });

  it("accountsChanged clears the previous account's state immediately", async () => {
    const s = make();
    s.setAccount(A);
    await s.refresh();
    s.setAccount(B);
    expect(s.read("position")).toEqual({ stale: false });
    expect(s.read("watchtower")).toEqual({ stale: false });
  });

  it("never shows account A's data under account B", async () => {
    const s = make();
    s.setAccount(A);
    await s.refresh();
    s.setAccount(B);
    await s.refresh();
    expect(s.read<{ owner: string }>("position").value?.owner).toBe(B);
  });

  it("a response still in flight for A is dropped after switching to B", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r: ChainReader = {
      async view(method: string, args: unknown[] = []) {
        if (args[0] === A) await gate;
        return { owner: args[0], method } as never;
      },
    };
    const s = new AccountScope(createAccountLoader(r));
    s.setAccount(A);
    const pending = s.refresh();
    s.setAccount(B);
    release();
    await pending;
    expect(s.read("position")).toEqual({ stale: false });
    await s.refresh();
    expect(s.read<{ owner: string }>("position").value?.owner).toBe(B);
  });

  it("disconnecting (null) clears and stops reading", async () => {
    const s = make();
    s.setAccount(A);
    await s.refresh();
    expect(s.setAccount(null)).toBe(true);
    expect(s.account).toBeNull();
    expect(s.read("position")).toEqual({ stale: false });
    await expect(s.refresh()).resolves.toBeUndefined();
  });

  it("keeps the last good position when a refresh fails (per-item retention)", async () => {
    let fail = false;
    const r: ChainReader = {
      async view(method: string) {
        if (fail && method === "get_position") throw new Error("rpc");
        return { method } as never;
      },
    };
    const s = new AccountScope(createAccountLoader(r));
    s.setAccount(A);
    await s.refresh();
    fail = true;
    await s.refresh();
    const pos = s.read("position");
    expect(pos.value).toEqual({ method: "get_position" });
    expect(pos.stale).toBe(true);
    expect(pos.error).toBe("rpc");
    expect(s.read("watchtower").error).toBeUndefined();
  });
});

describe("loadRecentReports", () => {
  it("loads newest first, serially, up to the limit", async () => {
    const order: number[] = [];
    const r = reader({ get_report: (a) => (order.push(a[0] as number), { id: a[0] }) });
    const l = createPublicLoader(r);
    const out = await loadRecentReports(l, 10, 3);
    expect(order).toEqual([10, 9, 8]);
    expect(out.map((s) => (s.value as { id: number }).id)).toEqual([10, 9, 8]);
  });

  it("handles fewer reports than the limit", async () => {
    const l = createPublicLoader(reader({ get_report: (a) => ({ id: a[0] }) }));
    expect(await loadRecentReports(l, 2, 6)).toHaveLength(2);
  });

  it("returns nothing when there are no reports", async () => {
    const l = createPublicLoader(reader({}));
    expect(await loadRecentReports(l, 0)).toEqual([]);
  });

  it("one failing report does not hide the others", async () => {
    const l = createPublicLoader(
      reader({
        get_report: (a) => {
          if (a[0] === 2) throw new Error("bad");
          return { id: a[0] };
        },
      }),
    );
    const out = await loadRecentReports(l, 3, 3);
    expect(out.map((s) => s.error ?? "ok")).toEqual(["ok", "bad", "ok"]);
  });

  it("does not call the reader at all when count is zero", async () => {
    const view = vi.fn();
    await loadRecentReports(createPublicLoader({ view }), 0);
    expect(view).not.toHaveBeenCalled();
  });
});
