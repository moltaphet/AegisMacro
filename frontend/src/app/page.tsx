"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import { LendingSandbox } from "@/components/LendingSandbox";
import { Footer } from "@/components/Footer";
import { ProtocolExplainer } from "@/components/ProtocolExplainer";
import { RiskTierDashboard } from "@/components/RiskTierDashboard";
import { SyncAlert } from "@/components/SyncAlert";
import { WatchtowerDesk } from "@/components/WatchtowerDesk";
import { GhostButton, TierChip } from "@/components/ui";
import { NETWORK } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { lastReportHealth, slotHealth } from "@/lib/feedHealth";
import { useDashboard } from "@/lib/useDashboard";
import type { FeedHealth } from "@/lib/types";

const MacroGlobe3D = dynamic(() => import("@/components/MacroGlobe3D"), {
  ssr: false,
  loading: () => <div className="glass flex h-[420px] items-center justify-center text-sm text-ink-mute">Loading 3D feed network…</div>,
});

export default function Page() {
  const d = useDashboard();
  const level = d.risk?.risk_level ?? 0;

  useEffect(() => {
    document.documentElement.dataset.tier = String(level);
  }, [level]);

  const health = useMemo<FeedHealth[]>(() => {
    const loaded = d.feeds !== undefined;
    const base = [0, 1, 2].map((i) => slotHealth(d.feeds?.[i], loaded));
    const recent = lastReportHealth(d.reports[0]);
    // A report that only reached two sources degrades the overall picture honestly.
    return recent === "unknown" ? base : base.map((h) => (h === "ok" && recent !== "ok" ? "degraded" : h));
  }, [d.feeds, d.reports]);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-6 pt-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Macro-risk SOC console</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">AegisMacro</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">Autonomous macroeconomic risk oracle and liquidity circuit breaker, reading three independent feeds on GenLayer.</p>
        </div>
        <div className="flex items-center gap-3">
          {d.risk && <TierChip level={level} />}
          {d.account ? (
            <span className="tabular rounded-full border border-silver-deep bg-white/70 px-3 py-1.5 font-mono text-xs" title={d.account}>
              {shortAddr(d.account)}
              {!d.onRightChain && <span className="ml-2 text-critical">wrong chain</span>}
            </span>
          ) : (
            <GhostButton onClick={() => void d.connect()}>Connect wallet</GhostButton>
          )}
        </div>
      </header>

      {d.walletError && (
        <p role="alert" className="mb-4 rounded-xl border border-critical/40 bg-critical/10 px-4 py-3 text-sm">
          {d.walletError}
        </p>
      )}
      <div className="mb-6">
        <SyncAlert sync={d.sync} onRetry={() => void d.refresh()} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <MacroGlobe3D tier={level} feeds={d.feeds} health={health} />
        <RiskTierDashboard risk={d.risk} state={d.state} now={d.now} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* keyed by wallet so a switch can never carry the previous account's form or panel state */}
        <WatchtowerDesk key={`wt-${d.account ?? "none"}`} d={d} />
        <LendingSandbox key={`lend-${d.account ?? "none"}`} d={d} />
      </div>

      <section className="mt-6" aria-label="Protocol design">
        <ProtocolExplainer />
      </section>

      <p className="mt-6 text-xs text-ink-mute">
        {NETWORK.name} · chain {NETWORK.chainId}
      </p>
      <Footer />
    </main>
  );
}
