"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectWallet,
  getProvider,
  readView,
  readWallet,
  sendWrite,
  watchWallet,
  type Eip1193Provider,
  type WriteOutcome,
} from "./contract";
import { CONTRACT_ADDRESS, NETWORK, isConfigured } from "./config";
import { deriveSync, type SyncStatus } from "./sync";
import {
  AccountScope,
  PUBLIC_KEYS,
  createAccountLoader,
  createPublicLoader,
  loadRecentReports,
} from "./stores";
import type {
  FeedSource,
  Position,
  ProtocolState,
  ReportRecord,
  RiskStatus,
  RiskTierRow,
  WatchtowerStats,
} from "./types";

export interface TxState {
  phase: "idle" | "estimating" | "signing" | "confirming" | "done" | "error";
  label: string;
  hash?: string;
  error?: string;
}

const POLL_MS = 20_000;
const REPORT_WINDOW = 6;

export function useDashboard() {
  const configured = isConfigured(CONTRACT_ADDRESS);
  const reader = useMemo(() => ({ view: readView }), []);
  const publicLoader = useMemo(() => createPublicLoader(reader), [reader]);
  const scope = useMemo(() => new AccountScope(createAccountLoader(reader)), [reader]);

  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [tx, setTx] = useState<TxState>({ phase: "idle", label: "" });
  const [walletError, setWalletError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const offA = publicLoader.subscribe(rerender);
    const offB = scope.loader.subscribe(rerender);
    return () => {
      offA();
      offB();
    };
  }, [publicLoader, scope, rerender]);

  const refresh = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    try {
      await publicLoader.loadAll([...PUBLIC_KEYS, "report_count"]);
      const count = Number((publicLoader.get("report_count").value as number | undefined) ?? 0);
      await loadRecentReports(publicLoader, count, REPORT_WINDOW);
      await scope.refresh();
      const anyOk = [...PUBLIC_KEYS].some((k) => publicLoader.get(k).error === undefined && publicLoader.get(k).value !== undefined);
      if (anyOk) setLastOkAt(Math.floor(Date.now() / 1000));
    } finally {
      setLoading(false);
    }
  }, [configured, publicLoader, scope]);

  // Account switch: clear account-scoped state immediately, then reload.
  const applyAccount = useCallback(
    (next: string | null) => {
      const changed = scope.setAccount(next);
      setAccount(scope.account);
      if (changed) {
        setTx({ phase: "idle", label: "" });
        void scope.refresh();
      }
    },
    [scope],
  );

  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;
    let cancelled = false;
    readWallet(provider)
      .then((w) => {
        if (cancelled) return;
        setChainId(w.chainId);
        applyAccount(w.account);
      })
      .catch(() => undefined);
    const off = watchWallet(
      provider,
      (accounts) => applyAccount(accounts[0] ?? null),
      (id) => setChainId(id),
    );
    return () => {
      cancelled = true;
      off();
    };
  }, [applyAccount]);

  useEffect(() => {
    // First read on the next tick (not synchronously in the effect body), then poll.
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      void refresh();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setWalletError(null);
    try {
      const w = await connectWallet();
      setChainId(w.chainId);
      applyAccount(w.account);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }, [applyAccount]);

  const write = useCallback(
    async (label: string, method: string, args: (string | number | bigint | boolean)[], value = 0n): Promise<WriteOutcome | null> => {
      const provider: Eip1193Provider | null = getProvider();
      if (!provider || !account) {
        setTx({ phase: "error", label, error: "Connect a wallet first." });
        return null;
      }
      const startedFor = account;
      try {
        setTx({ phase: "estimating", label });
        const out = await sendWrite(provider, { account, method, args, value }, (phase) =>
          setTx({ phase, label }),
        );
        if (scope.account !== startedFor) return out; // account changed mid-flight: say nothing about it
        setTx({ phase: "done", label, hash: out.hash });
        await refresh();
        return out;
      } catch (e) {
        if (scope.account === startedFor) {
          setTx({ phase: "error", label, error: e instanceof Error ? e.message : String(e) });
        }
        return null;
      }
    },
    [account, refresh, scope],
  );

  const reportCount = Number((publicLoader.get("report_count").value as number | undefined) ?? 0);
  const reportKeys = Array.from({ length: Math.min(reportCount, REPORT_WINDOW) }, (_, i) => `report:${reportCount - i}`);

  const results: Record<string, boolean | undefined> = {};
  for (const k of [...PUBLIC_KEYS, "report_count", ...reportKeys]) {
    const s = publicLoader.get(k);
    results[k] = s.value === undefined && s.error === undefined ? undefined : s.error === undefined;
  }
  if (account) {
    for (const kind of ["position", "watchtower"] as const) {
      const s = scope.read(kind);
      results[`${kind}:${account}`] = s.value === undefined && s.error === undefined ? undefined : s.error === undefined;
    }
  }
  const sync: SyncStatus = deriveSync({ configured, loading, results, lastOkAt });

  const reports = reportKeys
    .map((k) => publicLoader.get(k).value as ReportRecord | undefined)
    .filter((r): r is ReportRecord => r !== undefined);

  return {
    configured,
    account,
    chainId,
    onRightChain: chainId === NETWORK.chainId,
    walletError,
    connect,
    refresh,
    write,
    tx,
    now,
    sync,
    state: publicLoader.get("state").value as ProtocolState | undefined,
    risk: publicLoader.get("risk").value as RiskStatus | undefined,
    tiers: publicLoader.get("tiers").value as RiskTierRow[] | undefined,
    feeds: publicLoader.get("feeds").value as FeedSource[] | undefined,
    reports,
    position: scope.read<Position>("position").value,
    watchtower: scope.read<WatchtowerStats>("watchtower").value,
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
