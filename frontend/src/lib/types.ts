export type RiskLevel = 0 | 1 | 2;
export type Verdict = 0 | 1 | 2;

export interface RiskStatus {
  risk_level: RiskLevel;
  risk_name: string;
  max_ltv_bps: number;
  base_borrow_rate_bps: number;
  reserve_factor_bps: number;
  last_applied_epoch: number;
  updated_at: number;
  shift_count: number;
}

export interface RiskTierRow {
  risk_level: RiskLevel;
  risk_name: string;
  max_ltv_bps: number;
  base_borrow_rate_bps: number;
  reserve_factor_bps: number;
}

export interface FeedSource {
  slot: number;
  label: string;
  host: string;
  base_url: string;
  operator: string;
  pending_base_url: string;
  pending_operator: string;
  rotation_eta: number;
}

export interface ProtocolState {
  governor: string;
  pending_governor: string;
  watchtower_bond_wei: string;
  risk_level: RiskLevel;
  risk_name: string;
  max_ltv_bps: number;
  base_borrow_rate_bps: number;
  reserve_factor_bps: number;
  last_applied_epoch: number;
  shift_count: number;
  report_count: number;
  verified_reports: number;
  rejected_reports: number;
  inconclusive_reports: number;
  insurance_reserve_wei: string;
  reserve_pool_wei: string;
  pool_cash_wei: string;
  total_collateral_wei: string;
  total_borrows_wei: string;
  total_shares: string;
  total_claimable_wei: string;
  borrow_index: string;
  contract_balance_wei: string;
  tracked_wei: string;
  solvent: boolean;
}

export interface ReportRecord {
  report_id: number;
  watchtower: string;
  epoch: number;
  claimed_level: number;
  verdict: Verdict;
  verdict_name: string;
  quorum_present: boolean;
  quorum_level: number;
  source_count: number;
  announcement_hash: string;
  bond_wei: string;
  bounty_wei: string;
  slashed_wei: string;
  level_changed: boolean;
  created_at: number;
}

export interface WatchtowerStats {
  address: string;
  verified: number;
  rejected: number;
  inconclusive: number;
  claimable_wei: string;
}

export interface Position {
  address: string;
  collateral_wei: string;
  debt_wei: string;
  principal_wei: string;
  interest_wei: string;
  current_ltv_bps: number;
  max_ltv_bps: number;
  borrowable_wei: string;
  over_limit: boolean;
  lp_shares: string;
  lp_value_wei: string;
}

export type FeedHealth = "ok" | "degraded" | "down" | "unknown";
