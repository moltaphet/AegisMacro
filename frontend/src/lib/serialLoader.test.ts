import { describe, expect, it, vi } from "vitest";
import { MonotonicClock } from "./clock";
import { SerialLoader } from "./serialLoader";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MonotonicClock", () => {
  it("never repeats, even when wall time stalls", () => {
    const c = new MonotonicClock(() => 1000);
    const ticks = Array.from({ length: 5 }, () => c.next());
    expect(ticks).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  it("never goes backwards when wall time steps back", () => {
    let t = 5000;
    const c = new MonotonicClock(() => t);
    const a = c.next();
    t = 100;
    const b = c.next();
    expect(b).toBeGreaterThan(a);
  });

  it("follows wall time when it moves forward", () => {
    let t = 10;
    const c = new MonotonicClock(() => t);
    c.next();
    t = 500;
    expect(c.next()).toBe(500);
    expect(c.peek()).toBe(500);
  });
});

describe("SerialLoader", () => {
  it("stores a successful load", async () => {
    const l = new SerialLoader(async (k) => `v:${k}`);
    const s = await l.load("a");
    expect(s.value).toBe("v:a");
    expect(s.stale).toBe(false);
    expect(s.error).toBeUndefined();
  });

  it("returns an empty state for an unknown key", () => {
    const l = new SerialLoader(async () => 1);
    expect(l.get("nope")).toEqual({ stale: false });
  });

  it("runs loads strictly one at a time", async () => {
    let active = 0;
    let peak = 0;
    const l = new SerialLoader(async (k) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return k;
    });
    await Promise.all([l.load("a"), l.load("b"), l.load("c"), l.load("d")]);
    expect(peak).toBe(1);
  });

  it("runs loads in request order", async () => {
    const order: string[] = [];
    const l = new SerialLoader(async (k) => {
      order.push(k);
      return k;
    });
    await Promise.all([l.load("x"), l.load("y"), l.load("z")]);
    expect(order).toEqual(["x", "y", "z"]);
  });

  it("keeps the last good value when a refresh fails", async () => {
    let fail = false;
    const l = new SerialLoader(async () => {
      if (fail) throw new Error("rpc down");
      return 42;
    });
    await l.load("k");
    fail = true;
    const s = await l.load("k");
    expect(s.value).toBe(42);
    expect(s.error).toBe("rpc down");
    expect(s.stale).toBe(true);
    expect(s.failedAt).toBeGreaterThan(s.loadedAt as number);
  });

  it("records a failure with no prior value as not stale", async () => {
    const l = new SerialLoader<number>(async () => {
      throw new Error("boom");
    });
    const s = await l.load("k");
    expect(s.value).toBeUndefined();
    expect(s.error).toBe("boom");
    expect(s.stale).toBe(false);
  });

  it("clears the error and stale flag on the next success", async () => {
    let n = 0;
    const l = new SerialLoader(async () => {
      n += 1;
      if (n === 2) throw new Error("blip");
      return n;
    });
    await l.load("k");
    await l.load("k");
    const s = await l.load("k");
    expect(s.value).toBe(3);
    expect(s.error).toBeUndefined();
    expect(s.stale).toBe(false);
  });

  it("isolates failures per item", async () => {
    const l = new SerialLoader(async (k) => {
      if (k === "bad") throw new Error("x");
      return k;
    });
    await l.loadAll(["a", "bad", "c"]);
    expect(l.get("a").value).toBe("a");
    expect(l.get("c").value).toBe("c");
    expect(l.get("bad").error).toBe("x");
    expect(l.failedKeys()).toEqual(["bad"]);
  });

  it("a later failure does not erase other items' values", async () => {
    let fail = false;
    const l = new SerialLoader(async (k) => {
      if (fail && k === "b") throw new Error("b down");
      return k.toUpperCase();
    });
    await l.loadAll(["a", "b"]);
    fail = true;
    await l.loadAll(["a", "b"]);
    expect(l.get("a").value).toBe("A");
    expect(l.get("b").value).toBe("B");
    expect(l.get("b").stale).toBe(true);
  });

  it("an older in-flight response never overwrites a newer one", async () => {
    const first = deferred<string>();
    let calls = 0;
    const l = new SerialLoader(async () => {
      calls += 1;
      return calls === 1 ? first.promise : "new";
    });
    const p1 = l.load("k");
    await tick(); // p1 is now genuinely in flight
    const p2 = l.load("k"); // newer ticket, queued behind p1
    first.resolve("old");
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
    expect(l.get("k").value).toBe("new");
  });

  it("skips a queued load that a newer request for the same key supersedes", async () => {
    const fetcher = vi.fn(async (k: string) => k);
    const gate = deferred<void>();
    const l = new SerialLoader(async (k) => {
      if (k === "block") await gate.promise;
      return fetcher(k);
    });
    const blocker = l.load("block");
    const a = l.load("dup");
    const b = l.load("dup");
    gate.resolve();
    await Promise.all([blocker, a, b]);
    expect(fetcher.mock.calls.filter(([k]) => k === "dup")).toHaveLength(1);
  });

  it("clear() drops state immediately", async () => {
    const l = new SerialLoader(async () => 1);
    await l.load("a");
    l.clear();
    expect(l.get("a")).toEqual({ stale: false });
    expect(l.keys()).toEqual([]);
  });

  it("a response that lands after clear() is discarded", async () => {
    const slow = deferred<string>();
    const l = new SerialLoader(async () => slow.promise);
    const p = l.load("acct:old");
    await tick(); // in flight
    l.clear();
    slow.resolve("old-account-data");
    await p;
    expect(l.get("acct:old").value).toBeUndefined();
  });

  it("a failure that lands after clear() is discarded too", async () => {
    const slow = deferred<string>();
    const l = new SerialLoader(async () => slow.promise);
    const p = l.load("k");
    await tick(); // in flight
    l.clear();
    slow.reject(new Error("late"));
    await p;
    expect(l.get("k").error).toBeUndefined();
  });

  it("a load queued before clear() never even fetches", async () => {
    const fetcher = vi.fn(async (k: string) => k);
    const gate = deferred<void>();
    const l = new SerialLoader(async (k) => {
      if (k === "block") await gate.promise;
      return fetcher(k);
    });
    const blocker = l.load("block");
    const queued = l.load("queued");
    await tick();
    l.clear();
    gate.resolve();
    await Promise.all([blocker, queued]);
    expect(fetcher.mock.calls.map((c) => c[0])).not.toContain("queued");
    expect(l.keys()).toEqual([]);
  });

  it("loads issued after clear() work normally", async () => {
    const l = new SerialLoader(async (k) => k);
    await l.load("a");
    l.clear();
    expect((await l.load("a")).value).toBe("a");
  });

  it("notifies subscribers and supports unsubscribe", async () => {
    const l = new SerialLoader(async (k) => k);
    const fn = vi.fn();
    const off = l.subscribe(fn);
    await l.load("a");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    await l.load("b");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports busy while work is queued", async () => {
    const gate = deferred<void>();
    const l = new SerialLoader(async () => {
      await gate.promise;
      return 1;
    });
    const p = l.load("a");
    expect(l.busy).toBe(true);
    gate.resolve();
    await p;
    expect(l.busy).toBe(false);
  });

  it("assigns strictly increasing load ticks", async () => {
    const l = new SerialLoader(async (k) => k, new MonotonicClock(() => 1));
    const a = await l.load("a");
    const b = await l.load("b");
    expect((b.loadedAt as number) > (a.loadedAt as number)).toBe(true);
  });

  it("survives a fetcher that throws a non-Error", async () => {
    const l = new SerialLoader<number>(async () => {
      throw "plain string";
    });
    expect((await l.load("k")).error).toBe("plain string");
  });
});
