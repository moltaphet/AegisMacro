/**
 * Run one extra live report against the recorded deployment and append the
 * result to deployments/studio-next.json ("extra_transactions").
 *
 *   SCENARIO_EPOCH=6 SCENARIO_LEVEL=2 node --no-warnings --env-file=.env.deploy deploy/live_scenario.ts
 *
 * Epoch 6 in the committed fixtures is a three-way split (A=CRITICAL, B=ELEVATED,
 * C=NORMAL): the contract must answer QUORUM_FAILURE and leave the bond claimable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "deployments", "studio-next.json");
const RPC = process.env.GENLAYER_RPC_URL ?? "https://studio-next.genlayer.com/api";

const STATUS = ["UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "UNDETERMINED", "FINALIZED", "CANCELED"];
const EXECUTION = ["NOT_VOTED", "FINISHED_WITH_RETURN", "FINISHED_WITH_ERROR"];
const RESOLUTION = ["IDLE", "MAJORITY_AGREE", "MAJORITY_DISAGREE", "MAJORITY_TIMEOUT", "DETERMINISTIC_VIOLATION", "NO_MAJORITY"];
const nm = (name: unknown, num: unknown, t: string[]) => (typeof name === "string" && name ? name : t[Number(num)]);

function normalize(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), normalize(x)]));
  if (Array.isArray(v)) return v.map(normalize);
  return v;
}

const req = createRequire(path.join(ROOT, "frontend", "package.json"));
const sdk = await import(pathToFileURL(req.resolve("genlayer-js")).href);
const { studioDevnet } = await import(pathToFileURL(req.resolve("genlayer-js/chains")).href);
const chain = { ...studioDevnet, rpcUrls: { default: { http: [RPC] } } };
const rec = JSON.parse(readFileSync(OUT, "utf8"));
const address = rec.contract_address as string;
const account = sdk.createAccount(process.env.WATCHTOWER_PRIVATE_KEY);
const client = sdk.createClient({ chain, endpoint: RPC, account });
const reader = sdk.createClient({ chain, endpoint: RPC });
const epoch = BigInt(process.env.SCENARIO_EPOCH ?? "6");
const level = BigInt(process.env.SCENARIO_LEVEL ?? "2");
const bond = BigInt(rec.watchtower_bond_wei);

const fees = await client.estimateTransactionFeesForWrite({ account, address, functionName: "report_risk", args: [epoch, level], value: bond });
const hash = await client.writeContract({
  account, address, functionName: "report_risk", args: [epoch, level], value: bond,
  fees: { distribution: fees.distribution, messageAllocations: fees.messageAllocations, feeValue: fees.feeValue },
});
console.log(`report_risk(epoch ${epoch}, tier ${level}) tx ${hash}`);
const r = await client.waitForTransactionReceipt({ hash, waitUntil: "decided", retries: 200, interval: 3000 });
const status = nm(r.statusName, r.status, STATUS);
const execution = nm(r.txExecutionResultName, r.txExecutionResult, EXECUTION);
const resolution = nm(r.resultName ?? r.result_name, r.result, RESOLUTION);
if (!["ACCEPTED", "FINALIZED"].includes(status) || execution !== "FINISHED_WITH_RETURN" || resolution !== "MAJORITY_AGREE") {
  throw new Error(`not final: ${status}/${execution}/${resolution}`);
}
const count = Number(await reader.readContract({ address, functionName: "get_report_count", args: [] }));
const report = normalize(await reader.readContract({ address, functionName: "get_report", args: [BigInt(count)] }));
const wt = normalize(await reader.readContract({ address, functionName: "get_watchtower", args: [account.address] }));
const state = normalize(await reader.readContract({ address, functionName: "get_protocol_state", args: [] }));
const risk = normalize(await reader.readContract({ address, functionName: "get_risk_status", args: [] }));
console.log(JSON.stringify({ report, watchtower: wt }, null, 1));

rec.extra_transactions = [
  ...(rec.extra_transactions ?? []),
  { label: `report_risk epoch ${epoch} claim ${level}`, hash, status, execution, resolution, value_wei: bond.toString(), report, watchtower_after: wt },
];
rec.readbacks_latest = { get_protocol_state: state, get_risk_status: risk };
writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
console.log("appended to deployments/studio-next.json");
