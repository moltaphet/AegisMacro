// Honest sync status: derived from what the loaders actually hold, never from
// optimism. Partial failures are listed by panel so the UI can say exactly which
// numbers are last-known rather than live.

export type SyncPhase = "unconfigured" | "loading" | "live" | "partial" | "offline";

export interface SyncStatus {
  phase: SyncPhase;
  failedKeys: string[];
  lastOkAt: number | null;
  message: string;
}

export interface SyncInput {
  configured: boolean;
  loading: boolean;
  /** Per-key outcome: true loaded, false failed, undefined never attempted. */
  results: Record<string, boolean | undefined>;
  lastOkAt: number | null;
}

const LABELS: Record<string, string> = {
  state: "protocol state",
  risk: "risk tier",
  tiers: "tier table",
  feeds: "feed registry",
  report_count: "report count",
};

export function labelForKey(key: string): string {
  if (LABELS[key]) return LABELS[key];
  if (key.startsWith("report:")) return `report #${key.slice(7)}`;
  if (key.startsWith("position:")) return "your lending position";
  if (key.startsWith("watchtower:")) return "your Watchtower record";
  return key;
}

export function deriveSync(input: SyncInput): SyncStatus {
  if (!input.configured) {
    return {
      phase: "unconfigured",
      failedKeys: [],
      lastOkAt: null,
      message: "This build has no AegisMacro contract address configured, so no live data is shown.",
    };
  }
  const entries = Object.entries(input.results).filter(([, v]) => v !== undefined);
  const failed = entries.filter(([, v]) => v === false).map(([k]) => k);
  const okCount = entries.length - failed.length;
  if (entries.length === 0) {
    return {
      phase: "loading",
      failedKeys: [],
      lastOkAt: input.lastOkAt,
      message: input.loading ? "Reading the chain…" : "Waiting for the first read.",
    };
  }
  if (failed.length === 0) {
    return { phase: "live", failedKeys: [], lastOkAt: input.lastOkAt, message: "Live from GenLayer Studio Next." };
  }
  if (okCount === 0) {
    return {
      phase: "offline",
      failedKeys: failed,
      lastOkAt: input.lastOkAt,
      message: "The RPC did not answer any read. Figures on screen are the last values received, if any.",
    };
  }
  const names = failed.map(labelForKey).join(", ");
  return {
    phase: "partial",
    failedKeys: failed,
    lastOkAt: input.lastOkAt,
    message: `Some reads failed: ${names}. Those panels show their last received values.`,
  };
}
