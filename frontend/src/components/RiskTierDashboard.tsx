import { bpsToPercent, TIERS } from "@/lib/bps";
import { formatDuration, formatGen, formatTimestamp } from "@/lib/format";
import type { ProtocolState, RiskStatus } from "@/lib/types";
import { Card, Stat, TIER_BG, TIER_RING, TIER_SOFT, TIER_TEXT, TierChip } from "./ui";

export function RiskTierDashboard({ risk, state, now }: { risk?: RiskStatus; state?: ProtocolState; now: number }) {
  const level = risk?.risk_level ?? 0;
  return (
    <Card
      eyebrow="Active macro risk tier"
      title={risk ? risk.risk_name : "Awaiting first read"}
      right={risk ? <TierChip level={level} /> : undefined}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Max LTV" value={risk ? `${bpsToPercent(risk.max_ltv_bps)}%` : "-"} hint={risk ? `${risk.max_ltv_bps} bps` : undefined} tone={TIER_TEXT[level]} />
        <Stat label="Borrow rate" value={risk ? `${bpsToPercent(risk.base_borrow_rate_bps)}%` : "-"} hint={risk ? `${risk.base_borrow_rate_bps} bps APR` : undefined} tone={TIER_TEXT[level]} />
        <Stat label="Reserve factor" value={risk ? `${bpsToPercent(risk.reserve_factor_bps)}%` : "-"} hint={risk ? `${risk.reserve_factor_bps} bps` : undefined} tone={TIER_TEXT[level]} />
        <Stat label="Last epoch" value={risk ? `#${risk.last_applied_epoch}` : "-"} hint={risk ? `${risk.shift_count} shift${risk.shift_count === 1 ? "" : "s"}` : undefined} />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm" aria-label="Risk tier BPS matrix">
          <thead>
            <tr className="eyebrow">
              <th className="py-2 pr-3 font-semibold">Tier</th>
              <th className="py-2 pr-3 font-semibold">Max LTV</th>
              <th className="py-2 pr-3 font-semibold">Borrow APR</th>
              <th className="py-2 font-semibold">Reserve</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => {
              const active = t.level === level && !!risk;
              return (
                <tr
                  key={t.level}
                  aria-current={active ? "true" : undefined}
                  className={`tabular border-t border-silver ${active ? `${TIER_SOFT[t.level]} ring-1 ${TIER_RING[t.level]}` : ""}`}
                >
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <span className={`h-2 w-2 rounded-full ${TIER_BG[t.level]}`} aria-hidden />
                      {t.short}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{t.maxLtvBps.toString()} bps</td>
                  <td className="py-2 pr-3">{t.borrowRateBps.toString()} bps</td>
                  <td className="py-2">{t.reserveFactorBps.toString()} bps</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {state && (
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-silver pt-4 sm:grid-cols-4">
          <Stat label="Insurance (locked)" value={`${formatGen(state.insurance_reserve_wei)} GEN`} hint="slashed bonds" />
          <Stat label="Reserve pool" value={`${formatGen(state.reserve_pool_wei)} GEN`} hint="funds bounties" />
          <Stat label="Pool cash" value={`${formatGen(state.pool_cash_wei)} GEN`} />
          <Stat label="Solvency" value={state.solvent ? "balanced" : "DRIFT"} tone={state.solvent ? "text-normal" : "text-critical"} hint={`${formatGen(state.contract_balance_wei)} / ${formatGen(state.tracked_wei)} GEN`} />
        </dl>
      )}
      {risk && risk.updated_at > 0 && (
        <p className="mt-3 text-xs text-ink-mute">
          Tier in force since {formatTimestamp(risk.updated_at)} ({formatDuration(Math.max(0, now - risk.updated_at))} ago)
        </p>
      )}
    </Card>
  );
}
