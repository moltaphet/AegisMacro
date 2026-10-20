// Float-free formatting + parsing for wei amounts, timestamps and addresses.

const ATTO = 10n ** 18n;

export function toBigInt(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  try {
    return typeof v === "bigint" ? v : BigInt(v);
  } catch {
    return 0n;
  }
}

/** wei -> "1.234" GEN with at most `dp` decimals (truncated, never rounded up). */
export function formatGen(wei: string | number | bigint | null | undefined, dp = 4): string {
  const v = toBigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ATTO;
  const frac = (abs % ATTO).toString().padStart(18, "0").slice(0, dp);
  const trimmed = frac.replace(/0+$/, "");
  const body = trimmed.length > 0 ? `${whole}.${trimmed}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/** Strict decimal GEN string -> wei, or null. Rejects signs, exponents, >18 dp. */
export function parseGen(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) && !/^\.\d{1,18}$/.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  const w = whole === "" ? 0n : BigInt(whole);
  return w * ATTO + BigInt(frac.padEnd(18, "0"));
}

export function shortAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return "-";
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return "-";
  return h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

export function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}
