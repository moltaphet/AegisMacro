"""Fill the LIVE-DEPLOYMENT block of README.md from deployments/studio-next.json.

Every number in the block is copied from the recorded gen_call readbacks, never
typed by hand. Re-run after any redeploy.
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
rec = json.loads((ROOT / "deployments" / "studio-next.json").read_text())
rb = rec["readbacks"]
state, risk, feeds = rb["get_protocol_state"], rb["get_risk_status"], rb["get_feed_sources"]
tx = rec["transactions"]
exp = rec["explorer_url"].rsplit("/address/", 1)[0]


def gen(wei: str) -> str:
    v = int(wei)
    s = f"{v // 10**18}.{v % 10**18:018d}".rstrip("0").rstrip(".")
    return s or "0"


rows = [
    ("Network", f"GenLayer Studio Next · chain `{rec['chain_id']}` · `{rec['rpc_url']}`"),
    ("Contract", f"[`{rec['contract_address']}`]({rec['explorer_url']})"),
    ("Source SHA-256", f"`{rec['source_sha256']}`"),
    ("Runner header", "`" + rec["runner_header"].replace("\n", " ").replace("# ", "", 1) + "`"),
    ("Deployer (fresh)", f"`{rec['deployer']}`"),
    ("Watchtower (fresh)", f"`{rec['watchtower']}`"),
    ("Feed commit", f"`{rec['feed_commit']}`"),
]
txrows = [
    ("deploy", tx["deploy"]),
    ("seed_liquidity (0.5 GEN)", tx["seed_liquidity"]),
    (f"report_risk (epoch {tx['report_risk']['epoch']}, tier {tx['report_risk']['claimed_level']})", tx["report_risk"]),
]
out = ["## Live deployment (Studio Next)", "", "| | |", "|---|---|"]
out += [f"| {k} | {v} |" for k, v in rows]
out += ["", "| Transaction | Hash | Status | Execution | Resolution |", "|---|---|---|---|---|"]
for name, t in txrows:
    out.append(f"| {name} | [`{t['hash']}`]({exp}/tx/{t['hash']}) | {t['status']} | {t['execution']} | {t['resolution']} |")
out += [
    "",
    "Authoritative `gen_call` readbacks recorded after the transactions above (full JSON in `deployments/studio-next.json`):",
    "",
    "```text",
    f"get_risk_status      -> {risk['risk_name']} · max_ltv {risk['max_ltv_bps']} bps · rate {risk['base_borrow_rate_bps']} bps · reserve {risk['reserve_factor_bps']} bps",
    f"                        last_applied_epoch {risk['last_applied_epoch']} · shift_count {risk['shift_count']}",
    f"get_protocol_state   -> pool_cash {gen(state['pool_cash_wei'])} GEN · claimable {gen(state['total_claimable_wei'])} GEN · insurance {gen(state['insurance_reserve_wei'])} GEN",
    f"                        contract_balance {gen(state['contract_balance_wei'])} GEN · tracked {gen(state['tracked_wei'])} GEN · solvent {str(state['solvent']).lower()}",
    f"                        reports {state['report_count']} (verified {state['verified_reports']}, rejected {state['rejected_reports']}, inconclusive {state['inconclusive_reports']})",
]
for f in feeds:
    out.append(f"get_feed_sources[{f['slot']}] -> {f['label']:<27} {f['host']:<26} operator {f['operator']}")
    out.append(f"                        {f['base_url']}")
out += ["```", ""]
for x in rec.get("extra_transactions", []):
    r = x["report"]
    out.append(
        f"Extra live scenario: **{x['label']}** -> [`{x['hash']}`]({exp}/tx/{x['hash']}) "
        f"({x['status']}/{x['execution']}/{x['resolution']}): verdict **{r['verdict_name']}**, "
        f"{r['source_count']}/3 sources answered, slashed {gen(r['slashed_wei'])} GEN; "
        f"Watchtower claimable afterwards {gen(x['watchtower_after']['claimable_wei'])} GEN (both bonds intact)."
    )
    out.append("")
block = "\n".join(out)

readme = ROOT / "README.md"
text = readme.read_text()
new = re.sub(
    r"<!-- LIVE-DEPLOYMENT-START -->.*?<!-- LIVE-DEPLOYMENT-END -->",
    lambda _m: "<!-- LIVE-DEPLOYMENT-START -->\n" + block + "<!-- LIVE-DEPLOYMENT-END -->",
    text,
    flags=re.S,
)
readme.write_text(new)
print("README live block updated")
