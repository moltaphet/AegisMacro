// Network + deployment configuration. The contract address is injected at build
// time (NEXT_PUBLIC_AEGISMACRO_ADDRESS) so a redeploy is a config change.

export const NETWORK = {
  chainId: 61997,
  chainIdHex: "0xf22d",
  name: "GenLayer Studio Next",
  rpcUrl: process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "https://studio-next.genlayer.com/api",
  explorerUrl: "https://explorer-studio-next.genlayer.com",
  currency: { name: "GEN", symbol: "GEN", decimals: 18 },
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CONTRACT_ADDRESS: string =
  process.env.NEXT_PUBLIC_AEGISMACRO_ADDRESS ?? ZERO_ADDRESS;

export const REPO_URL = "https://github.com/moltaphet/AegisMacro";

export function isConfigured(address: string = CONTRACT_ADDRESS): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && address.toLowerCase() !== ZERO_ADDRESS;
}

export function explorerAddressUrl(address: string): string {
  return `${NETWORK.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${NETWORK.explorerUrl}/tx/${hash}`;
}
