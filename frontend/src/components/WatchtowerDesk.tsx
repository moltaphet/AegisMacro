"use client";

import { useMemo, useState } from "react";
import { MIN_WATCHTOWER_BOND } from "@/lib/bps";
import { formatGen, formatTimestamp, parseGen, shortAddr, shortHash, toBigInt } from "@/lib/format";
import type { Dashboard } from "@/lib/useDashboard";
import { Card, Field, GhostButton, PrimaryButton, Stat, TIER_SHORT, TIER_TEXT, TierChip, TxStatus, inputClass } from "./ui";

const VERDICT = [
  { name: "REJECTED", tone: "bg-critical/10 text-critical", note: "bond slashed" },
  { name: "VERIFIED", tone: "bg-normal/10 text-normal", note: "tier applied" },
  { name: "QUORUM FAILURE", tone: "bg-elevated/10 text-elevated", note: "bond intact" },
] as const;

const EPOCH_WINDOW = 16;
const LABELS = ["Report risk", "Claim payout"];

export function WatchtowerDesk({ d }: { d: Dashboard }) {
  const last = d.risk?.last_applied_epoch ?? 0;
  const bond = d.state ? toBigInt(d.state.watchtower_bond_wei) : MIN_WATCHTOWER_BOND;
  const [epochText, setEpochText] = useState("");
  const [level, setLevel] = useState<0 | 1 | 2>(1);
  const [bondText, setBondText] = useState("");

  const epoch = epochText === "" ? last + 1 : Number(epochText);
  const bondWei = bondText === "" ? bond : parseGen(bondText);
  const problems = useMemo(() => {
    const out: string[] = [];
    if (!Number.isInteger(epoch) || epoch < last + 1 || epoch > last + EPOCH_WINDOW) {
      out.push(`Epoch must be a whole number from ${last + 1} to ${last + EPOCH_WINDOW}.`);
    }
    if (bondWei === null) out.push("Bond must be a plain decimal amount in GEN.");
    else if (bondWei < bond) out.push(`Bond must be at least ${formatGen(bond, 6)} GEN.`);
    return out;
  }, [epoch, last, bondWei, bond]);

  const ready = d.configured && !!d.account && d.onRightChain && problems.length === 0 && bondWei !== null;
  const claimable = toBigInt(d.watchtower?.claimable_wei);

  return (
    <Card eyebrow="Staked Watchtower desk" title="Propose a risk shift" right={<TierChip level={level} />}>
      <p className="mb-4 text-sm text-ink-soft">
        You pick the epoch and the tier you claim. The contract reads its own three registered mirrors; there is no URL field to abuse.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Epoch" hint={`next is ${last + 1}`}>
          <input className={inputClass} inputMode="numeric" placeholder={String(last + 1)} value={epochText} onChange={(e) => setEpochText(e.target.value.trim())} aria-label="Epoch" />
        </Field>
        <Field label="Claimed tier">
          <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Claimed tier">
            {([0, 1, 2] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={level === l}
                onClick={() => setLevel(l)}
                className={`rounded-lg border px-1 py-2 text-xs font-semibold transition ${level === l ? `border-transparent bg-ink text-white` : "border-silver-deep bg-white/70 text-ink-soft hover:bg-white"}`}
              >
                {TIER_SHORT[l]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Bond (GEN)" hint={`min ${formatGen(bond, 6)}`}>
          <input className={inputClass} inputMode="decimal" placeholder={formatGen(bond, 6)} value={bondText} onChange={(e) => setBondText(e.target.value)} aria-label="Bond in GEN" />
        </Field>
      </div>

      <ul className="mt-4 space-y-1.5 text-xs">
        {VERDICT.map((v) => (
          <li key={v.name} className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 font-semibold ${v.tone}`}>{v.name}</span>
            <span className="text-ink-mute">
              {v.name === "VERIFIED" && "two sources agree with your claim"}
              {v.name === "REJECTED" && "two sources contradict you, or two return 404"}
              {v.name === "QUORUM FAILURE" && "too few answers or an outage; retry"} · {v.note}
            </span>
          </li>
        ))}
      </ul>

      {problems.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-critical" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton
          tone={level}
          disabled={!ready}
          onClick={() => bondWei !== null && void d.write("Report risk", "report_risk", [BigInt(epoch), BigInt(level)], bondWei)}
        >
          Stake {bondWei !== null ? formatGen(bondWei, 4) : "?"} GEN & report
        </PrimaryButton>
        {!d.account && <span className="text-xs text-ink-mute">Connect a wallet to report.</span>}
        {d.account && !d.onRightChain && <span className="text-xs text-critical">Switch to chain 61997.</span>}
      </div>
      <TxStatus tx={d.tx} scope={LABELS} />

      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-silver pt-4 sm:grid-cols-4">
        <Stat label="Verified" value={d.state?.verified_reports ?? "-"} tone="text-normal" />
        <Stat label="Rejected" value={d.state?.rejected_reports ?? "-"} tone="text-critical" />
        <Stat label="Inconclusive" value={d.state?.inconclusive_reports ?? "-"} tone="text-elevated" />
        <Stat label="Insurance" value={d.state ? `${formatGen(d.state.insurance_reserve_wei)} GEN` : "-"} hint="locked, slashed bonds" />
      </div>

      {d.account && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink/5 px-4 py-3 text-sm">
          <div>
            <p className="eyebrow">Your record · {shortAddr(d.account)}</p>
            <p className="tabular mt-1 text-ink-soft">
              {d.watchtower ? `${d.watchtower.verified} verified · ${d.watchtower.rejected} slashed · ${d.watchtower.inconclusive} retried` : "loading…"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="tabular font-semibold">{formatGen(claimable, 4)} GEN claimable</span>
            <GhostButton disabled={claimable === 0n || !d.onRightChain} onClick={() => void d.write("Claim payout", "claim_payout", [])}>
              Claim
            </GhostButton>
          </div>
        </div>
      )}

      <div className="mt-6">
        <p className="eyebrow mb-2">Recent reports</p>
        {d.reports.length === 0 ? (
          <p className="text-sm text-ink-mute">No reports yet.</p>
        ) : (
          <ol className="divide-y divide-silver">
            {d.reports.map((r) => (
              <li key={r.report_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="tabular w-10 font-semibold text-ink-mute">#{r.report_id}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${VERDICT[r.verdict]?.tone ?? ""}`}>{VERDICT[r.verdict]?.name ?? r.verdict_name}</span>
                <span className="text-xs text-ink-soft">
                  epoch {r.epoch} · claimed <span className={TIER_TEXT[Math.min(r.claimed_level, 2)]}>{TIER_SHORT[Math.min(r.claimed_level, 2)]}</span> · {r.source_count}/3 sources
                </span>
                <span className="tabular ml-auto text-xs text-ink-mute">
                  {r.slashed_wei !== "0" ? `slashed ${formatGen(r.slashed_wei)} GEN` : r.bounty_wei !== "0" ? `bounty ${formatGen(r.bounty_wei)} GEN` : `bond ${formatGen(r.bond_wei)} GEN`}
                </span>
                <span className="basis-full text-xs text-ink-mute">
                  {shortAddr(r.watchtower)} · {formatTimestamp(r.created_at)}
                  {r.announcement_hash && <> · hash {shortHash(r.announcement_hash)}</>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
