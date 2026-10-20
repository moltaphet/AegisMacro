"use client";

import { useMemo, useState } from "react";
import { bpsToPercent, tierOf } from "@/lib/bps";
import { formatGen, parseGen, toBigInt } from "@/lib/format";
import { healthOf, simulate } from "@/lib/simulator";
import type { Dashboard } from "@/lib/useDashboard";
import { Card, Field, PrimaryButton, Stat, TIER_BG, TIER_SHORT, TIER_TEXT, TxStatus, inputClass } from "./ui";

interface Action {
  id: string;
  label: string;
  method: string;
  payable: boolean;
  hint: string;
}

const ACTIONS: Action[] = [
  { id: "supply", label: "Supply liquidity", method: "seed_liquidity", payable: true, hint: "Adds idle cash to the pool and mints shares." },
  { id: "deposit", label: "Deposit collateral", method: "deposit_collateral", payable: true, hint: "Posts GEN as collateral." },
  { id: "borrow", label: "Borrow", method: "borrow", payable: false, hint: "Limited by the active tier's max LTV." },
  { id: "repay", label: "Repay", method: "repay", payable: true, hint: "Interest first, then principal. Overpayment is refundable." },
  { id: "withdraw", label: "Withdraw collateral", method: "withdraw", payable: false, hint: "Must keep the position within the active max LTV." },
  { id: "unsupply", label: "Withdraw liquidity (shares)", method: "withdraw_liquidity", payable: false, hint: "Burns shares for GEN, limited by idle cash." },
];

const HEALTH_STYLE = { safe: "bg-normal", tight: "bg-elevated", over: "bg-critical" } as const;
const SCOPE = ACTIONS.map((a) => a.label);

export function LendingSandbox({ d }: { d: Dashboard }) {
  const level = d.risk?.risk_level ?? 0;
  const tier = tierOf(level);
  const [actionId, setActionId] = useState("deposit");
  const [amountText, setAmountText] = useState("");
  const [simCollateral, setSimCollateral] = useState("10");
  const [simBorrow, setSimBorrow] = useState("5");

  const action = ACTIONS.find((a) => a.id === actionId) ?? ACTIONS[0];
  const isShares = action.id === "unsupply";
  const amount = isShares ? (/^\d+$/.test(amountText) ? BigInt(amountText) : null) : parseGen(amountText);
  const canSend = d.configured && !!d.account && d.onRightChain && amount !== null && amount > 0n;

  const sim = useMemo(() => {
    const c = parseGen(simCollateral);
    const b = parseGen(simBorrow);
    return c !== null && b !== null && c > 0n ? simulate(c, b) : null;
  }, [simCollateral, simBorrow]);

  const p = d.position;
  const submit = () => {
    if (amount === null) return;
    if (action.payable) void d.write(action.label, action.method, [], amount);
    else void d.write(action.label, action.method, [amount]);
  };

  return (
    <Card eyebrow="Integrated lending sandbox" title={`Bound to ${TIER_SHORT[level]} · max LTV ${bpsToPercent(tier.maxLtvBps)}%`}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Pool cash" value={d.state ? `${formatGen(d.state.pool_cash_wei)} GEN` : "-"} />
        <Stat label="Borrowed" value={d.state ? `${formatGen(d.state.total_borrows_wei)} GEN` : "-"} />
        <Stat label="Collateral" value={d.state ? `${formatGen(d.state.total_collateral_wei)} GEN` : "-"} />
        <Stat label="Borrow APR" value={`${bpsToPercent(tier.borrowRateBps)}%`} tone={TIER_TEXT[level]} hint={`reserve ${bpsToPercent(tier.reserveFactorBps)}%`} />
      </div>

      {d.account && (
        <div className="mt-5 rounded-xl bg-ink/5 p-4">
          <p className="eyebrow">Your position</p>
          {p ? (
            <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Collateral" value={`${formatGen(p.collateral_wei)} GEN`} />
              <Stat label="Debt" value={`${formatGen(p.debt_wei)} GEN`} hint={`interest ${formatGen(p.interest_wei)}`} />
              <Stat label="LTV" value={`${bpsToPercent(p.current_ltv_bps)}%`} tone={p.over_limit ? "text-critical" : "text-ink"} hint={p.over_limit ? "over the active limit" : `limit ${bpsToPercent(p.max_ltv_bps)}%`} />
              <Stat label="LP value" value={`${formatGen(p.lp_value_wei)} GEN`} hint={`${p.lp_shares} shares`} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-mute">Loading your position…</p>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Action" hint={action.hint}>
          <select className={inputClass} value={actionId} onChange={(e) => setActionId(e.target.value)} aria-label="Lending action">
            {ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={isShares ? "Shares" : "Amount (GEN)"}>
          <input className={inputClass} inputMode="decimal" placeholder={isShares ? "0" : "0.0"} value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount" />
        </Field>
        <PrimaryButton tone={level} disabled={!canSend} onClick={submit}>
          {action.label}
        </PrimaryButton>
      </div>
      {amountText !== "" && amount === null && <p className="mt-2 text-xs text-critical" role="alert">{isShares ? "Shares must be a whole number." : "Enter a plain decimal amount, up to 18 places."}</p>}
      <TxStatus tx={d.tx} scope={SCOPE} />

      <div className="mt-6 border-t border-silver pt-5">
        <p className="eyebrow">LTV health simulator</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Collateral (GEN)">
            <input className={inputClass} inputMode="decimal" value={simCollateral} onChange={(e) => setSimCollateral(e.target.value)} aria-label="Simulated collateral" />
          </Field>
          <Field label="Borrow (GEN)">
            <input className={inputClass} inputMode="decimal" value={simBorrow} onChange={(e) => setSimBorrow(e.target.value)} aria-label="Simulated borrow" />
          </Field>
        </div>
        {sim === null ? (
          <p className="mt-3 text-sm text-ink-mute">Enter collateral above zero to simulate.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {sim.map((s) => {
              const h = healthOf(s);
              const active = s.tier.level === level;
              return (
                <li key={s.tier.level} className={`rounded-xl border px-4 py-3 ${active ? "border-ink/30 bg-white/80" : "border-silver bg-white/40"}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className={`h-2 w-2 rounded-full ${TIER_BG[s.tier.level]}`} aria-hidden />
                    <span className="font-semibold">{s.tier.short}</span>
                    {active && <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">active</span>}
                    <span className="tabular text-ink-mute">max borrow {formatGen(s.maxBorrow, 4)} GEN</span>
                    <span className={`ml-auto text-xs font-semibold ${h === "over" ? "text-critical" : h === "tight" ? "text-elevated" : "text-normal"}`}>
                      {h === "over" ? "over limit" : h === "tight" ? "tight" : "safe"}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-silver" role="progressbar" aria-label={`${s.tier.short} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(s.utilizationPct, 100)}>
                    <div className={`h-full rounded-full ${HEALTH_STYLE[h]}`} style={{ width: `${Math.min(s.utilizationPct, 100)}%` }} />
                  </div>
                  <p className="tabular mt-1.5 text-xs text-ink-mute">
                    LTV {bpsToPercent(s.currentLtvBps)}% of {bpsToPercent(s.tier.maxLtvBps)}% · 1y interest {formatGen(s.interestOneYear, 5)} GEN · reserve cut {formatGen(s.reserveOneYear, 5)} GEN
                    {s.collateralShortfall > 0n && <> · needs +{formatGen(s.collateralShortfall, 4)} GEN collateral</>}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {d.state && toBigInt(d.state.pool_cash_wei) === 0n && <p className="mt-3 text-xs text-ink-mute">The pool has no idle cash yet; supply liquidity before borrowing.</p>}
      </div>
    </Card>
  );
}
