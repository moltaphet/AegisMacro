// Dashboard data stores. Public protocol data and per-account data live in two
// separate SerialLoaders: switching wallet account clears ONLY the account
// store, and every account key embeds the address so a late response for the
// previous account can never be rendered for the new one.

import { SerialLoader, type ItemState } from "./serialLoader";
import type {
  FeedSource,
  Position,
  ProtocolState,
  ReportRecord,
  RiskStatus,
  RiskTierRow,
  WatchtowerStats,
} from "./types";

export interface ChainReader {
  view<T>(method: string, args?: (string | number | bigint | boolean)[]): Promise<T>;
}

export const PUBLIC_KEYS = ["state", "risk", "tiers", "feeds"] as const;
export type PublicKey = (typeof PUBLIC_KEYS)[number];

export function accountKeys(account: string): string[] {
  const a = account.toLowerCase();
  return [`position:${a}`, `watchtower:${a}`];
}

export function createPublicLoader(reader: ChainReader): SerialLoader<unknown> {
  return new SerialLoader<unknown>(async (key) => {
    if (key === "state") return reader.view<ProtocolState>("get_protocol_state");
    if (key === "risk") return reader.view<RiskStatus>("get_risk_status");
    if (key === "tiers") return reader.view<RiskTierRow[]>("get_risk_tiers");
    if (key === "feeds") return reader.view<FeedSource[]>("get_feed_sources");
    if (key.startsWith("report:")) return reader.view<ReportRecord>("get_report", [Number(key.slice(7))]);
    if (key === "report_count") return reader.view<number>("get_report_count");
    throw new Error(`unknown public key ${key}`);
  });
}

export function createAccountLoader(reader: ChainReader): SerialLoader<unknown> {
  return new SerialLoader<unknown>(async (key) => {
    if (key.startsWith("position:")) return reader.view<Position>("get_position", [key.slice(9)]);
    if (key.startsWith("watchtower:")) return reader.view<WatchtowerStats>("get_watchtower", [key.slice(11)]);
    throw new Error(`unknown account key ${key}`);
  });
}

/** Holds the active account and owns the account-scoped loader. */
export class AccountScope {
  private current: string | null = null;
  constructor(readonly loader: SerialLoader<unknown>) {}

  get account(): string | null {
    return this.current;
  }

  /** Returns true when the account actually changed (and state was cleared). */
  setAccount(next: string | null): boolean {
    const norm = next ? next.toLowerCase() : null;
    if (norm === this.current) return false;
    this.current = norm;
    this.loader.clear();
    return true;
  }

  /** Read the active account's item; never returns another account's data. */
  read<T>(kind: "position" | "watchtower"): ItemState<T> {
    if (!this.current) return { stale: false };
    return this.loader.get(`${kind}:${this.current}`) as ItemState<T>;
  }

  async refresh(): Promise<void> {
    const account = this.current;
    if (!account) return;
    await this.loader.loadAll(accountKeys(account));
  }
}

/** Latest reports, newest first, loaded serially with per-item failure retention. */
export async function loadRecentReports(
  loader: SerialLoader<unknown>,
  count: number,
  limit = 6,
): Promise<ItemState<unknown>[]> {
  const ids: number[] = [];
  for (let id = count; id >= 1 && ids.length < limit; id -= 1) ids.push(id);
  const out: ItemState<unknown>[] = [];
  for (const id of ids) out.push(await loader.load(`report:${id}`));
  return out;
}
