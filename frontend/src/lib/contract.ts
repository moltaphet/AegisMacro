// GenLayer SDK integration: EIP-1193 wallet, fee estimation with
// estimateTransactionFeesForWrite, strict receipt finality, and the view reads
// behind the dashboard. Re-exports SerialLoader and the receipt gate so callers
// have a single import for "talk to the chain safely".

import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { CONTRACT_ADDRESS, NETWORK, isConfigured } from "./config";
import { assertFinalReceipt, type ReceiptLike } from "./receipt";

export { SerialLoader } from "./serialLoader";
export { MonotonicClock } from "./clock";
export { assertFinalReceipt, receiptProblem, ReceiptError } from "./receipt";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export type Hex = `0x${string}`;
type SdkClient = ReturnType<typeof createClient>;
type CalldataArg = string | number | bigint | boolean;
type TxHash = Parameters<SdkClient["waitForTransactionReceipt"]>[0]["hash"];

export interface WalletState {
  account: string | null;
  chainId: number | null;
}

// ---------------------------------------------------------------------------
// Calldata normalisation: genlayer-js decodes dicts to Map and ints to bigint.
// ---------------------------------------------------------------------------
export function normalizeCalldata(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) out[String(k)] = normalizeCalldata(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(normalizeCalldata);
  if (value instanceof Uint8Array) return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return value;
}

// ---------------------------------------------------------------------------
// Wallet (EIP-1193)
// ---------------------------------------------------------------------------
export function getProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

export function parseChainId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(raw)) return Number(raw);
  return null;
}

export async function readWallet(provider: Eip1193Provider): Promise<WalletState> {
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  const chain = await provider.request({ method: "eth_chainId" });
  return { account: accounts[0]?.toLowerCase() ?? null, chainId: parseChainId(chain) };
}

export async function ensureNetwork(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NETWORK.chainIdHex }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: NETWORK.chainIdHex,
          chainName: NETWORK.name,
          nativeCurrency: NETWORK.currency,
          rpcUrls: [NETWORK.rpcUrl],
          blockExplorerUrls: [NETWORK.explorerUrl],
        },
      ],
    });
  }
}

export async function connectWallet(): Promise<WalletState> {
  const provider = getProvider();
  if (!provider) throw new Error("No EIP-1193 wallet found. Install a wallet that can add GenLayer Studio Next.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet returned no account.");
  await ensureNetwork(provider);
  return readWallet(provider);
}

/** Subscribe to account/chain changes. Returns an unsubscribe function. */
export function watchWallet(
  provider: Eip1193Provider,
  onAccounts: (accounts: string[]) => void,
  onChain: (chainId: number | null) => void,
): () => void {
  const a = (...args: unknown[]) => onAccounts(Array.isArray(args[0]) ? (args[0] as string[]) : []);
  const c = (...args: unknown[]) => onChain(parseChainId(args[0]));
  provider.on?.("accountsChanged", a);
  provider.on?.("chainChanged", c);
  return () => {
    provider.removeListener?.("accountsChanged", a);
    provider.removeListener?.("chainChanged", c);
  };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const chain = { ...studioDevnet, rpcUrls: { default: { http: [NETWORK.rpcUrl] } } };

let readClient: SdkClient | null = null;
export function getReadClient(): SdkClient {
  readClient ??= createClient({ chain, endpoint: NETWORK.rpcUrl });
  return readClient;
}

export function getWriteClient(provider: Eip1193Provider, account: string): SdkClient {
  return createClient({ chain, endpoint: NETWORK.rpcUrl, account: account as Hex, provider: provider as never });
}

function requireAddress(): Hex {
  if (!isConfigured()) throw new Error("AegisMacro contract address is not configured for this build.");
  return CONTRACT_ADDRESS as Hex;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function readView<T>(method: string, args: CalldataArg[] = []): Promise<T> {
  const result = await getReadClient().readContract({
    address: requireAddress(),
    functionName: method,
    args,
  });
  return normalizeCalldata(result) as T;
}

// ---------------------------------------------------------------------------
// Writes: estimate fees with the SDK, send, wait, then gate on the receipt.
// ---------------------------------------------------------------------------
export interface WriteRequest {
  account: string;
  method: string;
  args?: CalldataArg[];
  value?: bigint;
}

export interface WriteOutcome {
  hash: Hex;
  receipt: ReceiptLike;
  feeValue: bigint;
}

export async function estimateWriteFees(client: SdkClient, req: WriteRequest) {
  return client.estimateTransactionFeesForWrite({
    address: requireAddress(),
    functionName: req.method,
    args: req.args ?? [],
    value: req.value ?? 0n,
  });
}

export async function sendWrite(
  provider: Eip1193Provider,
  req: WriteRequest,
  onPhase?: (phase: "estimating" | "signing" | "confirming") => void,
): Promise<WriteOutcome> {
  const client = getWriteClient(provider, req.account);
  onPhase?.("estimating");
  const estimate = await estimateWriteFees(client, req);
  onPhase?.("signing");
  const hash = (await client.writeContract({
    address: requireAddress(),
    functionName: req.method,
    args: req.args ?? [],
    value: req.value ?? 0n,
    fees: {
      distribution: estimate.distribution,
      messageAllocations: estimate.messageAllocations,
      feeValue: estimate.feeValue,
    },
  })) as Hex;
  onPhase?.("confirming");
  const receipt = await client.waitForTransactionReceipt({ hash: hash as unknown as TxHash, waitUntil: "decided", retries: 200, interval: 3000 });
  return { hash, receipt: assertFinalReceipt(receipt as ReceiptLike), feeValue: estimate.feeValue };
}
