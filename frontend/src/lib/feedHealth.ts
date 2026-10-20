import type { FeedHealth, FeedSource, ReportRecord } from "./types";

/** Coarse per-slot health from registry state only (no extra network call). */
export function slotHealth(feed: FeedSource | undefined, loaded: boolean): FeedHealth {
  if (!loaded || !feed) return "unknown";
  if (feed.rotation_eta > 0) return "degraded"; // a rotation is pending: watch it
  return "ok";
}

export function rotationCountdown(eta: number, now: number): number {
  return Math.max(0, eta - now);
}

/** What the last report says about overall feed reliability. */
export function lastReportHealth(r: ReportRecord | undefined): FeedHealth {
  if (!r) return "unknown";
  if (r.source_count >= 3) return "ok";
  if (r.source_count === 2) return "degraded";
  return "down";
}
