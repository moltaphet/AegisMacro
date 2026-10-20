/**
 * Autonomous Studio Next deploy for contracts/aegis_macro.py.
 *
 *   1. deploy the contract with the three commit-pinned feed bases + operators
 *   2. seed 0.5 GEN of lending liquidity from the deployer
 *   3. have the Watchtower stake the bond and file a live risk report
 *   4. read the state back with gen_call views and write deployments/studio-next.json
 *
 * Run from the repo root (Node >= 22.6 strips TypeScript types natively):
 *
 *   node --env-file=.env.deploy deploy/deploy_aegis_macro.ts
 *
 * Inputs (all from the environment, none hard-coded):
 *   DEPLOYER_PRIVATE_KEY, WATCHTOWER_PRIVATE_KEY   fresh, dedicated accounts
 *   OPERATOR_A/B/C                                 three distinct feed-operator ids
 *   FEED_SHA                                       the pushed commit the mirrors are pinned to
 *   WATCHTOWER_BOND_WEI (optional, default 0.2 GEN)
 *   REPORT_EPOCH / REPORT_LEVEL (optional, default 1 / 1)
 *   RESUME_DEPLOY_TX (optional)                    skip the deploy and continue from a finalised deploy tx
 *
 * genlayer-js is resolved from frontend/node_modules so this script has no
 * dependencies of its own.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT_PATH = path.join(ROOT, "contracts", "aegis_macro.py");
const OUT_PATH = path.join(ROOT, "deployments", "studio-next.json");
const RPC = process.env.GENLAYER_RPC_URL ?? "https://studio-next.genlayer.com/api";
const EXPLORER = "https://explorer-studio-next.genlayer.com";
const SEED_WEI = 5n * 10n ** 17n; // 0.5 GEN
const RETRIES = 200;
const INTERVAL_MS = 3000;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

async function loadSdk() {
  const req = createRequire(path.join(ROOT, "frontend", "package.json"));
  const main = await import(pathToFileURL(req.resolve("genlayer-js")).href);
  const chains = await import(pathToFileURL(req.resolve("genlayer-js/chains")).href);
  return { createClient: main.createClient, createAccount: main.createAccount, studioDevnet: chains.studioDevnet };
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), normalize(v)]));
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

interface Receipt {
  status?: number | string;
  statusName?: string;
  txExecutionResult?: number | string;
  txExecutionResultName?: string;
  result?: number | string;
  resultName?: string;
  result_name?: string;
  txDataDecoded?: { contractAddress?: string };
  data?: { contract_address?: string };
  [k: string]: unknown;
}

// Studio Next receipts carry numeric codes and only sometimes the names, so the
// names are derived from the SDK's own tables (genlayer-js transactions maps).
const STATUS = ["UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "UNDETERMINED", "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT", "LEADER_REVEALING"];
const EXECUTION = ["NOT_VOTED", "FINISHED_WITH_RETURN", "FINISHED_WITH_ERROR", "TIMEOUT", "NONDET_DISAGREE", "DETERMINISTIC_VIOLATION"];
const RESOLUTION = ["IDLE", "MAJORITY_AGREE", "MAJORITY_DISAGREE", "MAJORITY_TIMEOUT", "DETERMINISTIC_VIOLATION", "NO_MAJORITY"];

function nameOf(name: string | undefined, num: unknown, table: string[]): string | undefined {
  if (name) return name;
  const n = typeof num === "bigint" ? Number(num) : typeof num === "string" && /^\d+$/.test(num) ? Number(num) : num;
  return typeof n === "number" ? table[n] : undefined;
}

function finality(r: Receipt) {
  return {
    status: nameOf(r.statusName, r.status, STATUS),
    execution: nameOf(r.txExecutionResultName, r.txExecutionResult, EXECUTION),
    resolution: nameOf(r.resultName ?? r.result_name, r.result, RESOLUTION),
  };
}

function assertFinal(r: Receipt, what: string) {
  const f = finality(r);
  const ok = (f.status === "ACCEPTED" || f.status === "FINALIZED") && f.execution === "FINISHED_WITH_RETURN" && f.resolution === "MAJORITY_AGREE";
  if (!ok) throw new Error(`${what} did not finalise cleanly: ${f.status}/${f.execution}/${f.resolution}`);
  return f;
}

async function main() {
  const { createClient, createAccount, studioDevnet } = await loadSdk();
  const chain = { ...studioDevnet, rpcUrls: { default: { http: [RPC] } } };
  const deployer = createAccount(need("DEPLOYER_PRIVATE_KEY"));
  const watchtower = createAccount(need("WATCHTOWER_PRIVATE_KEY"));
  const dClient = createClient({ chain, endpoint: RPC, account: deployer });
  const wClient = createClient({ chain, endpoint: RPC, account: watchtower });
  const reader = createClient({ chain, endpoint: RPC });

  const sha = need("FEED_SHA");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("FEED_SHA must be a 40-hex commit sha");
  const bases = [
    `https://raw.githubusercontent.com/moltaphet/AegisMacro/${sha}/deployments/mock_feeds/a/`,
    `https://cdn.jsdelivr.net/gh/moltaphet/AegisMacro@${sha}/deployments/mock_feeds/b/`,
    `https://raw.githack.com/moltaphet/AegisMacro/${sha}/deployments/mock_feeds/c/`,
  ];
  const operators = [need("OPERATOR_A"), need("OPERATOR_B"), need("OPERATOR_C")];
  const bond = BigInt(process.env.WATCHTOWER_BOND_WEI ?? "200000000000000000");
  const epoch = BigInt(process.env.REPORT_EPOCH ?? "1");
  const level = BigInt(process.env.REPORT_LEVEL ?? "1");

  const code = readFileSync(CONTRACT_PATH);
  const sha256 = createHash("sha256").update(code).digest("hex");
  const header = code.toString("utf8").split("\n").slice(0, 2).join("\n");
  console.log(`contract sha256 ${sha256}`);
  console.log(`deployer   ${deployer.address}\nwatchtower ${watchtower.address}`);

  await dClient.initializeConsensusSmartContract();
  await wClient.initializeConsensusSmartContract();

  // ---- 1. deploy (or resume a deploy that already finalised) ---------------
  let deployHash = process.env.RESUME_DEPLOY_TX as string | undefined;
  let deployReceipt: Receipt;
  if (deployHash) {
    console.log(`resuming from deploy tx ${deployHash}`);
    deployReceipt = (await reader.getTransaction({ hash: deployHash })) as Receipt;
  } else {
    const deployFees = await dClient.estimateTransactionFees({});
    deployHash = (await dClient.deployContract({ code: new Uint8Array(code), args: [...bases, ...operators, bond], fees: deployFees })) as string;
    console.log(`deploy tx ${deployHash}`);
    deployReceipt = (await dClient.waitForTransactionReceipt({ hash: deployHash, waitUntil: "decided", retries: RETRIES, interval: INTERVAL_MS })) as Receipt;
  }
  const deployFinality = assertFinal(deployReceipt, "deploy");
  const address =
    process.env.RESUME_ADDRESS ??
    deployReceipt.txDataDecoded?.contractAddress ??
    deployReceipt.data?.contract_address ??
    (deployReceipt as { contract_address?: string }).contract_address ??
    (deployReceipt as { to_address?: string }).to_address;
  if (!address) throw new Error(`no contract address in deploy receipt: ${JSON.stringify(deployReceipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 400)}`);
  console.log(`AegisMacro deployed at ${address}`);

  async function write(client: typeof dClient, account: typeof deployer, method: string, args: unknown[], value: bigint, label: string) {
    const estimate = await client.estimateTransactionFeesForWrite({ account, address, functionName: method, args, value });
    const hash = await client.writeContract({
      account,
      address,
      functionName: method,
      args,
      value,
      fees: { distribution: estimate.distribution, messageAllocations: estimate.messageAllocations, feeValue: estimate.feeValue },
    });
    console.log(`${label} tx ${hash}`);
    const receipt = (await client.waitForTransactionReceipt({ hash, waitUntil: "decided", retries: RETRIES, interval: INTERVAL_MS })) as Receipt;
    const f = assertFinal(receipt, label);
    return { hash: hash as string, ...f };
  }

  // ---- 2. seed liquidity ---------------------------------------------------
  const seed = await write(dClient, deployer, "seed_liquidity", [], SEED_WEI, "seed_liquidity");

  // ---- 3. live risk report -------------------------------------------------
  const report = await write(wClient, watchtower, "report_risk", [epoch, level], bond, "report_risk");

  // ---- 4. authoritative readbacks (gen_call) -------------------------------
  const view = async (method: string, args: unknown[] = []) => normalize(await reader.readContract({ address, functionName: method, args }));
  const readbacks = {
    get_protocol_state: await view("get_protocol_state"),
    get_risk_status: await view("get_risk_status"),
    get_feed_sources: await view("get_feed_sources"),
    get_risk_tiers: await view("get_risk_tiers"),
    get_report_count: await view("get_report_count"),
    get_report_1: await view("get_report", [1n]),
    get_watchtower: await view("get_watchtower", [watchtower.address]),
    get_position_deployer: await view("get_position", [deployer.address]),
  };

  const record = {
    network: "studio-next",
    chain_id: 61997,
    rpc_url: RPC,
    contract_address: address,
    explorer_url: `${EXPLORER}/address/${address}`,
    source: "contracts/aegis_macro.py",
    runner_header: header,
    source_sha256: sha256,
    deployer: deployer.address,
    watchtower: watchtower.address,
    feed_commit: sha,
    feed_bases: bases,
    feed_operators: operators,
    watchtower_bond_wei: bond.toString(),
    transactions: {
      deploy: { hash: deployHash as string, ...deployFinality },
      seed_liquidity: { ...seed, value_wei: SEED_WEI.toString() },
      report_risk: { ...report, value_wei: bond.toString(), epoch: epoch.toString(), claimed_level: level.toString() },
    },
    readbacks,
    recorded_at: new Date().toISOString(),
  };
  writeFileSync(OUT_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(JSON.stringify({ address, sha256, deploy: deployHash, seed: seed.hash, report: report.hash }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
