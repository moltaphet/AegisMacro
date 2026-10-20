# AegisMacro

**Autonomous Macroeconomic Risk Oracle & Liquidity Circuit Breaker** — a GenLayer Intelligent Contract.

DeFi lending markets react to macro shocks (regulatory enforcement, central-bank surprises) at the speed of
governance forums. AegisMacro replaces that lag with a protocol-native circuit breaker: staked **Watchtowers**
propose a risk shift, the contract itself reads **three independent feed mirrors** through GenVM's web layer,
resolves a **2-of-3 quorum**, and — only then — moves the pool between three discrete risk tiers that bind
Max LTV, borrow rate and reserve factor in integer basis points.

> **Testnet software, synthetic data.** The feeds this deployment reads are mock fixtures
> (`deployments/mock_feeds/`, every record carries `"mock": true`). They are not statements from any
> regulator or central bank. Nothing here is financial advice.

<!-- LIVE-DEPLOYMENT-START -->
## Live deployment (Studio Next)

| | |
|---|---|
| Network | GenLayer Studio Next · chain `61997` · `https://studio-next.genlayer.com/api` |
| Contract | [`0xc8342FAFA7C492046244D27EFdd678ce429072A7`](https://explorer-studio-next.genlayer.com/address/0xc8342FAFA7C492046244D27EFdd678ce429072A7) |
| Source SHA-256 | `46bc19d88dd9d5b824585ed5a515d5edfe4f5b6b98c57e894f190d5735899711` |
| Runner header | `v0.3.0 # { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }` |
| Deployer (fresh) | `0x6Bc75Ab4c6C2945C26D732CC26A6331A3A327feD` |
| Watchtower (fresh) | `0xdA6db07b31527542bcb4C5D0098e1153df635cc7` |
| Feed commit | `efe61973ac8ce22ddc0c92bf3d5ebc4d2f298752` |

| Transaction | Hash | Status | Execution | Resolution |
|---|---|---|---|---|
| deploy | [`0x2a0303bd6855a7c35219946528cd19bf2497781974c1a29d79523a1c921873ec`](https://explorer-studio-next.genlayer.com/tx/0x2a0303bd6855a7c35219946528cd19bf2497781974c1a29d79523a1c921873ec) | ACCEPTED | FINISHED_WITH_RETURN | MAJORITY_AGREE |
| seed_liquidity (0.5 GEN) | [`0x2a3d4b98cdfa70ffa283594c637d7fd45d341ad2fc642211710fabe468b0de5b`](https://explorer-studio-next.genlayer.com/tx/0x2a3d4b98cdfa70ffa283594c637d7fd45d341ad2fc642211710fabe468b0de5b) | ACCEPTED | FINISHED_WITH_RETURN | MAJORITY_AGREE |
| report_risk (epoch 1, tier 1) | [`0x77bab82592d1524fc6f611c4a48e78bfe11630768e8ed41e546d549475708552`](https://explorer-studio-next.genlayer.com/tx/0x77bab82592d1524fc6f611c4a48e78bfe11630768e8ed41e546d549475708552) | ACCEPTED | FINISHED_WITH_RETURN | MAJORITY_AGREE |

Authoritative `gen_call` readbacks recorded after the transactions above (full JSON in `deployments/studio-next.json`):

```text
get_risk_status      -> RISK_LEVEL_ELEVATED · max_ltv 7000 bps · rate 750 bps · reserve 2000 bps
                        last_applied_epoch 1 · shift_count 1
get_protocol_state   -> pool_cash 0.5 GEN · claimable 0.2 GEN · insurance 0 GEN
                        contract_balance 0.7 GEN · tracked 0.7 GEN · solvent true
                        reports 1 (verified 1, rejected 0, inconclusive 0)
get_feed_sources[0] -> SEC_REGULATORY_MIRROR       raw.githubusercontent.com  operator 0x79526bb13ccc1688d201112b6a694c05a9d965c2
                        https://raw.githubusercontent.com/moltaphet/AegisMacro/efe61973ac8ce22ddc0c92bf3d5ebc4d2f298752/deployments/mock_feeds/a/
get_feed_sources[1] -> CENTRAL_BANK_MACRO_MIRROR   cdn.jsdelivr.net           operator 0x52494d6f473d0bff0022129a8b0e993dba209c12
                        https://cdn.jsdelivr.net/gh/moltaphet/AegisMacro@efe61973ac8ce22ddc0c92bf3d5ebc4d2f298752/deployments/mock_feeds/b/
get_feed_sources[2] -> GLOBAL_ECONOMIC_WIRE_MIRROR raw.githack.com            operator 0xe443d2572d9d72f4063e698b33cd56e5334cae31
                        https://raw.githack.com/moltaphet/AegisMacro/efe61973ac8ce22ddc0c92bf3d5ebc4d2f298752/deployments/mock_feeds/c/
```
<!-- LIVE-DEPLOYMENT-END -->

## 1. How it works

```
Watchtower ──report_risk(epoch, claimed_tier) + bond──▶ AegisMacro
                                                          │  reads (no user URL)
              ┌───────────────────────────────────────────┼───────────────────────────────┐
   Slot A  raw.githubusercontent.com        Slot B  cdn.jsdelivr.net        Slot C  raw.githack.com
   SEC / regulatory mirror                  central-bank / macro mirror     global economic wire mirror
              └───────────── each pinned to a 40-hex commit, 3 distinct operators ────────┘
                                                          │
                                  leader runs _aggregate, validators re-run it
                                                          ▼
              VERIFIED_RISK_SHIFT (1)  |  REJECTED_REPORT (0, bond slashed)  |  QUORUM_FAILURE (2, retry, bond intact)
                                                          ▼
                       NORMAL / ELEVATED / CRITICAL  →  Max LTV · Borrow rate · Reserve factor (bps)
```

| Tier | Meaning | Max LTV | Base borrow rate | Reserve factor |
|---|---|---|---|---|
| `RISK_LEVEL_NORMAL = 0` | stable macro conditions | 8000 (80%) | 400 (4.00%) | 1000 (10%) |
| `RISK_LEVEL_ELEVATED = 1` | tightening / regulatory scrutiny | 7000 (70%) | 750 (7.50%) | 2000 (20%) |
| `RISK_LEVEL_CRITICAL = 2` | emergency hike, systemic shock, hostile action | 5000 (50%) | 1200 (12.00%) | 4000 (40%) |

### The 5-step aggregate (`_aggregate`)

The leader fetches `<base>/epoch_<n>.json` from each registered mirror and classifies every source as
`OK(level, event)`, `NOT_FOUND` (HTTP 404/410) or `UNUSABLE` (5xx, 429, 403, redirects, timeouts, malformed
JSON, wrong epoch, out-of-range tier). Then:

1. Classify each source.
2. Tally identical `OK` records — two sources that agree on the same `(tier, event)` are a quorum.
3. Quorum **on the claimed tier** → `verdict = 1` `VERIFIED_RISK_SHIFT`.
4. Quorum on a **different** tier, or ≥ 2 × `NOT_FOUND` → `verdict = 0` `REJECTED_REPORT`. These are the **only** two ways to lose a bond.
5. Everything else — fewer than 2 responses, `1 CONFIRMED + 1 404 (lag) + 1 OUTAGE`, a three-way split, malformed bodies — → `verdict = 2` `QUORUM_FAILURE`: retryable, **bond intact**.

The consensus payload has exactly four fields:
`{"verdict": int, "risk_level": int, "source_count": int, "announcement_hash": str}`.
Validators re-fetch independently and must agree on `verdict`, `risk_level` and `announcement_hash`
(`sha256("epoch|level|event_id")`); `source_count` may differ by a transient outage. Every payload is
shape- and consistency-checked (`_payload_ok`) by every validator and again before settlement, so a malicious
leader cannot forge `verdict=1` with `risk_level=-1`, or a 1-source "quorum".

### Game theory

* **Bond**: `report_risk` requires `value ≥ watchtower_bond` (≥ 0.2 GEN, fixed at deployment).
* **Slashing**: 100% of a rejected bond goes to `insurance_reserve`. No function can move that reserve and
  the governor has no fund path at all (`test_insurance_reserve_has_no_public_outflow`).
* **Bounty**: 10% of the bond, paid from `reserve_pool` (the reserve-factor cut of lending interest), only
  when the verified report **changes** the tier, capped by the pool. One bounty per epoch — the first
  verified report consumes the epoch, so Sybil copies get `ERR_EPOCH_OUT_OF_RANGE`.
* **Replay / rollback**: an epoch must be strictly greater than the last applied one and at most 16 ahead.
* **No outage slashing**: a Watchtower can only be slashed on *definitive* contradiction.

### Governance (minimal by design)

Feed registry changes go through `propose_feed_rotation` → **7-day timelock** → `execute_feed_rotation`
(proposals expire 7 days after the eta; `cancel_feed_rotation` any time). A slot's host is fixed
(`raw.githubusercontent.com` / `cdn.jsdelivr.net` / `raw.githack.com`), the path must stay inside
`moltaphet/AegisMacro` at a 40-hex lowercase commit (a mutable branch is rejected), and the check
`len(set(hosts)) == 3 and len(set(operators)) == 3` is re-run at construction and at every execution.
Governor handover is two-step. Governor and feed operator are mutually exclusive roles, and that is enforced in
both directions across *queued* changes too: a pending governor cannot be proposed as a feed operator, a queued
rotation operator cannot be proposed as governor, and `accept_governor` / `execute_feed_rotation` re-check at the
moment they run, so concurrent proposals can never leave one address holding both roles.

### Integrated lending sandbox

`seed_liquidity` / `withdraw_liquidity` (share-priced pool), `deposit_collateral`, `borrow`, `repay`,
`withdraw`. Single-asset (GEN), so LTV is a pure ratio — no price oracle.

* LTV is enforced by exact cross-multiplication, `debt × 10000 ≤ collateral × max_ltv_bps` — no rounding
  window at the boundary.
* Interest accrues through a global borrow index at the **active tier's** rate; the index is advanced at the
  *old* rate immediately before a tier change.
* LP shares are priced at `pool_cash + total_borrows + pending interest`, with the global index accrued first.
  `total_borrows` only catches up when a borrower acts, so a pool-wide `norm_borrows` aggregate supplies the
  not-yet-realised interest: a new LP cannot buy into interest accrued before they arrived, and an exiting LP is
  paid the interest accrued up to their exit.
* Repayments apply to interest first; the active reserve factor skims `interest × rf // 10000` into
  `reserve_pool`.
* **Zero dust.** Every wei lives in exactly one bucket
  (`pool_cash + total_collateral + reserve_pool + insurance_reserve + total_claimable == balance`),
  checked after every operation of a randomised session against an independent ledger.
* Tightening the tier leaves existing loans *over limit* (flagged in `get_position`); they can repay but not
  borrow or withdraw until back inside. There is no liquidation engine — it is a sandbox.

### Float-free by construction

GenVM cannot ABI-encode a Python `float`. The contract has no float literal, no `float()`, no `/`, and no
float annotation (enforced by AST audits in the test-suite). Percentages are `int` basis points; wei
amounts in views are decimal strings so JavaScript never rounds them.

## 2. Repository layout

```
contracts/aegis_macro.py          the Intelligent Contract
deployments/mock_feeds/{a,b,c}/  commit-pinned synthetic feed fixtures (epoch_<n>.json)
deployments/studio-next.json     authoritative deployment record + live readbacks
deployments/aegis_macro_abi.json  schema as compiled by studio-next
deploy/deploy_aegis_macro.ts      deploy + seed + live report + readbacks
deploy/make_mock_feeds.py        regenerates the fixtures
tests/                           direct-mode suite (pytest)
frontend/                        Next.js 16 static export, Tailwind 4, Three.js SOC console
```

## 3. Toolchain notes (read before running the tests)

Studio Next executes **GenVM v0.3.0-rc7** and only knows the v0.3 runner
`py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (verified by compiling the contract with
`gen_getContractSchemaForCode` on the live RPC; the `1jb45…` runner is rejected as "runner malformed").
The current genvm-manager bundle (`v0.6.0-rc10`) no longer ships that runner, so the local linter and the
direct-mode harness must be pointed at a release that does. `v0.6.0-rc5` is known to ship it (verified by running the whole suite against it):

```bash
uv venv --python 3.12 && uv pip install --prerelease=allow -r requirements-dev.txt
export GENVM_VERSION=v0.6.0-rc5
.venv/bin/genvm-lint check     contracts/aegis_macro.py
.venv/bin/genvm-lint typecheck contracts/aegis_macro.py
.venv/bin/python -m pytest -q
```

Frontend:

```bash
cd frontend
npm ci
npx tsc --noEmit && npx eslint --max-warnings 0 . && npx vitest run
NEXT_PUBLIC_AEGISMACRO_ADDRESS=0x… npm run build      # static export → frontend/out
npm audit --registry=https://registry.npmjs.org
```

## 4. Deploying

```bash
# 1. publish the fixtures, note the commit sha, confirm HTTP 200 on all three hosts
# 2. fund the deployer and watchtower (testnet GEN), then:
FEED_SHA=<sha> node --env-file=.env.deploy deploy/deploy_aegis_macro.ts
```

`.env.deploy` (git-ignored) holds `DEPLOYER_PRIVATE_KEY`, `WATCHTOWER_PRIVATE_KEY` and `OPERATOR_A/B/C`.

## 5. Security notes and known limits

* Mirrors are CDNs over a GitHub repo: the three hosts are independent *delivery* paths, but all three serve
  one repository. Commit pinning makes the content immutable; it does not make it true. Production use needs
  genuinely independent publishers per slot (the registry and operator model already allow it).
* The synthetic fixtures are for demonstration. No LLM is in the consensus path on purpose: structured
  records plus a deterministic quorum rule leave nothing for validators to disagree about except reachability.
* The sandbox has no liquidation engine and no price oracle (single asset).
* `emit_transfer(..., on="finalized")` settles asynchronously after the transaction; a failure at that later
  stage cannot be caught in-call.
