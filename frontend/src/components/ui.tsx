import type { ReactNode } from "react";
import type { TxState } from "@/lib/useDashboard";
import { explorerTxUrl } from "@/lib/config";
import { shortHash } from "@/lib/format";

export const TIER_TEXT = ["text-normal", "text-elevated", "text-critical"] as const;
export const TIER_BG = ["bg-normal", "bg-elevated", "bg-critical"] as const;
export const TIER_SOFT = ["bg-normal/10", "bg-elevated/10", "bg-critical/10"] as const;
export const TIER_RING = ["ring-normal/40", "ring-elevated/40", "ring-critical/40"] as const;
export const TIER_HEX = ["#059669", "#D97706", "#DC2626"] as const;
export const TIER_SHORT = ["NORMAL", "ELEVATED", "CRITICAL"] as const;

export function Card({
  title,
  eyebrow,
  right,
  children,
  className = "",
}: {
  title?: string;
  eyebrow?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass p-5 sm:p-6 ${className}`}>
      {(title || eyebrow || right) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink">{title}</h2>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p className={`tabular mt-1 truncate text-xl font-semibold ${tone ?? "text-ink"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-mute">{hint}</p>}
    </div>
  );
}

export function TierChip({ level, className = "" }: { level: number; className?: string }) {
  const l = Math.min(Math.max(level, 0), 2);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${TIER_SOFT[l]} ${TIER_TEXT[l]} ${TIER_RING[l]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TIER_BG[l]}`} aria-hidden />
      {TIER_SHORT[l]}
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-ink-mute">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "tabular w-full rounded-lg border border-silver-deep bg-white/80 px-3 py-2 text-sm text-ink placeholder:text-ink-mute/70 disabled:opacity-50";

export function PrimaryButton({
  children,
  disabled,
  onClick,
  tone = 0,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: number;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${TIER_BG[tone]} hover:brightness-110`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-silver-deep bg-white/70 px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const PHASE_TEXT: Record<TxState["phase"], string> = {
  idle: "",
  estimating: "Estimating fees with the GenLayer SDK…",
  signing: "Confirm in your wallet…",
  confirming: "Waiting for validators (ACCEPTED/FINALIZED + MAJORITY_AGREE)…",
  done: "Confirmed.",
  error: "Failed.",
};

export function TxStatus({ tx, scope }: { tx: TxState; scope: string[] }) {
  if (tx.phase === "idle" || !scope.includes(tx.label)) return null;
  const isError = tx.phase === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mt-3 rounded-lg px-3 py-2 text-xs ${isError ? "bg-critical/10 text-critical" : "bg-ink/5 text-ink-soft"}`}
    >
      <span className="font-semibold">{tx.label}: </span>
      {isError ? (tx.error ?? PHASE_TEXT.error) : PHASE_TEXT[tx.phase]}
      {tx.hash && (
        <>
          {" "}
          <a className="underline" href={explorerTxUrl(tx.hash)} target="_blank" rel="noreferrer">
            {shortHash(tx.hash)}
          </a>
        </>
      )}
    </p>
  );
}
