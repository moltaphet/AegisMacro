import type { SyncStatus } from "@/lib/sync";
import { labelForKey } from "@/lib/sync";
import { formatTimestamp } from "@/lib/format";

const STYLE: Record<SyncStatus["phase"], string> = {
  unconfigured: "border-elevated/40 bg-elevated/10 text-ink",
  loading: "border-silver-deep bg-white/70 text-ink-soft",
  live: "",
  partial: "border-elevated/40 bg-elevated/10 text-ink",
  offline: "border-critical/40 bg-critical/10 text-ink",
};

export function SyncAlert({ sync, onRetry }: { sync: SyncStatus; onRetry: () => void }) {
  if (sync.phase === "live") return null;
  return (
    <div
      role={sync.phase === "offline" || sync.phase === "partial" ? "alert" : "status"}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${STYLE[sync.phase]}`}
    >
      <div>
        <p className="font-semibold">
          {sync.phase === "unconfigured" && "Contract not configured"}
          {sync.phase === "loading" && "Syncing"}
          {sync.phase === "partial" && "Partial sync"}
          {sync.phase === "offline" && "RPC unreachable"}
        </p>
        <p className="text-ink-soft">{sync.message}</p>
        {sync.failedKeys.length > 0 && (
          <ul className="mt-1 list-inside list-disc text-xs text-ink-mute">
            {sync.failedKeys.map((k) => (
              <li key={k}>{labelForKey(k)}</li>
            ))}
          </ul>
        )}
        {sync.lastOkAt && <p className="mt-1 text-xs text-ink-mute">Last good read: {formatTimestamp(sync.lastOkAt)}</p>}
      </div>
      {sync.phase !== "unconfigured" && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-silver-deep bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-alabaster"
        >
          Retry now
        </button>
      )}
    </div>
  );
}
