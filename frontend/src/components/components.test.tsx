// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SyncAlert } from "./SyncAlert";
import { RiskTierDashboard } from "./RiskTierDashboard";
import { ProtocolExplainer } from "./ProtocolExplainer";
import { Footer } from "./Footer";
import { TierChip, TxStatus } from "./ui";
import type { ProtocolState, RiskStatus } from "@/lib/types";

afterEach(cleanup);

const risk = (level: 0 | 1 | 2, ltv: number, rate: number, rf: number): RiskStatus => ({
  risk_level: level,
  risk_name: ["RISK_LEVEL_NORMAL", "RISK_LEVEL_ELEVATED", "RISK_LEVEL_CRITICAL"][level],
  max_ltv_bps: ltv,
  base_borrow_rate_bps: rate,
  reserve_factor_bps: rf,
  last_applied_epoch: 4,
  updated_at: 1790812800,
  shift_count: 2,
});

const state = {
  insurance_reserve_wei: "200000000000000000",
  reserve_pool_wei: "0",
  pool_cash_wei: "500000000000000000",
  contract_balance_wei: "700000000000000000",
  tracked_wei: "700000000000000000",
  solvent: true,
} as ProtocolState;

describe("SyncAlert", () => {
  it("renders nothing while live", () => {
    const { container } = render(<SyncAlert sync={{ phase: "live", failedKeys: [], lastOkAt: 1, message: "ok" }} onRetry={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("says the contract is not configured and offers no retry", () => {
    render(<SyncAlert sync={{ phase: "unconfigured", failedKeys: [], lastOkAt: null, message: "no address" }} onRetry={() => {}} />);
    expect(screen.getByText("Contract not configured")).toBeTruthy();
    expect(screen.queryByText("Retry now")).toBeNull();
  });

  it("lists each failed panel on a partial sync and retries on click", () => {
    const retry = vi.fn();
    render(<SyncAlert sync={{ phase: "partial", failedKeys: ["risk", "position:0xabc"], lastOkAt: 1790812800, message: "Some reads failed" }} onRetry={retry} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("risk tier")).toBeTruthy();
    expect(screen.getByText("your lending position")).toBeTruthy();
    expect(screen.getByText(/Last good read/)).toBeTruthy();
    fireEvent.click(screen.getByText("Retry now"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("flags an unreachable RPC", () => {
    render(<SyncAlert sync={{ phase: "offline", failedKeys: ["state"], lastOkAt: null, message: "down" }} onRetry={() => {}} />);
    expect(screen.getByText("RPC unreachable")).toBeTruthy();
  });

  it("is a polite status while loading", () => {
    render(<SyncAlert sync={{ phase: "loading", failedKeys: [], lastOkAt: null, message: "Reading the chain…" }} onRetry={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("RiskTierDashboard", () => {
  it("shows an empty state before the first read", () => {
    render(<RiskTierDashboard now={0} />);
    expect(screen.getByText("Awaiting first read")).toBeTruthy();
  });

  it.each([
    [0, 8000, 400, 1000, "80.00%", "4.00%", "10.00%"],
    [1, 7000, 750, 2000, "70.00%", "7.50%", "20.00%"],
    [2, 5000, 1200, 4000, "50.00%", "12.00%", "40.00%"],
  ] as const)("renders tier %i parameters as integer bps -> percent", (level, ltv, rate, rf, pLtv, pRate, pRf) => {
    render(<RiskTierDashboard risk={risk(level, ltv, rate, rf)} state={state} now={1790812800 + 90} />);
    expect(screen.getAllByText(pLtv).length).toBeGreaterThan(0);
    expect(screen.getAllByText(pRate).length).toBeGreaterThan(0);
    expect(screen.getAllByText(pRf).length).toBeGreaterThan(0);
  });

  it("marks exactly the active row", () => {
    render(<RiskTierDashboard risk={risk(1, 7000, 750, 2000)} state={state} now={0} />);
    const rows = screen.getAllByRole("row").filter((r) => r.getAttribute("aria-current") === "true");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("ELEVATED");
  });

  it("always lists all three tiers with their bps", () => {
    render(<RiskTierDashboard risk={risk(0, 8000, 400, 1000)} now={0} />);
    for (const bps of ["8000 bps", "7000 bps", "5000 bps", "400 bps", "750 bps", "1200 bps"]) {
      expect(screen.getAllByText(bps).length).toBeGreaterThan(0);
    }
  });

  it("shows solvency and the locked insurance reserve", () => {
    render(<RiskTierDashboard risk={risk(0, 8000, 400, 1000)} state={state} now={0} />);
    expect(screen.getByText("balanced")).toBeTruthy();
    expect(screen.getByText("0.2 GEN")).toBeTruthy();
  });

  it("flags solvency drift loudly", () => {
    render(<RiskTierDashboard risk={risk(0, 8000, 400, 1000)} state={{ ...state, solvent: false }} now={0} />);
    expect(screen.getByText("DRIFT")).toBeTruthy();
  });
});

describe("static panels", () => {
  it("explains the design in four cards", () => {
    render(<ProtocolExplainer />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
    expect(screen.getByText(/no URL|never pass a link/i)).toBeTruthy();
    expect(screen.getByText("2-of-3, outage-safe")).toBeTruthy();
  });

  it("footer warns that feeds are synthetic and has no live chip when unconfigured", () => {
    render(<Footer />);
    expect(screen.getByText("not configured")).toBeTruthy();
    expect(screen.getByText(/synthetic mock fixtures/)).toBeTruthy();
    expect(screen.getByText("Explorer").getAttribute("href")).toContain("explorer-studio-next");
  });
});

describe("ui atoms", () => {
  it.each([
    [0, "NORMAL"],
    [1, "ELEVATED"],
    [2, "CRITICAL"],
    [9, "CRITICAL"],
    [-4, "NORMAL"],
  ])("TierChip(%i) reads %s", (level, label) => {
    render(<TierChip level={level} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("TxStatus hides when idle or out of scope", () => {
    const { container, rerender } = render(<TxStatus tx={{ phase: "idle", label: "" }} scope={["A"]} />);
    expect(container.innerHTML).toBe("");
    rerender(<TxStatus tx={{ phase: "confirming", label: "B" }} scope={["A"]} />);
    expect(container.innerHTML).toBe("");
  });

  it("TxStatus spells out the strict finality being awaited", () => {
    render(<TxStatus tx={{ phase: "confirming", label: "Report risk" }} scope={["Report risk"]} />);
    expect(screen.getByRole("status").textContent).toMatch(/MAJORITY_AGREE/);
  });

  it("TxStatus shows errors as alerts and links the hash", () => {
    render(<TxStatus tx={{ phase: "error", label: "Report risk", error: "boom", hash: "0x" + "ab".repeat(32) }} scope={["Report risk"]} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(screen.getByRole("link").getAttribute("href")).toContain("/tx/0x");
  });
});
