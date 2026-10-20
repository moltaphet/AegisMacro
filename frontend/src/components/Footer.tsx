import { CONTRACT_ADDRESS, NETWORK, REPO_URL, explorerAddressUrl, isConfigured } from "@/lib/config";
import { shortAddr } from "@/lib/format";

export function Footer() {
  const live = isConfigured();
  return (
    <footer className="mt-12 border-t border-silver py-8 text-sm text-ink-mute">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Contract</span>
          {live ? (
            <a
              href={explorerAddressUrl(CONTRACT_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="tabular rounded-full border border-silver-deep bg-white/70 px-3 py-1 font-mono text-xs text-ink hover:bg-white"
              title={CONTRACT_ADDRESS}
            >
              {shortAddr(CONTRACT_ADDRESS, 8, 6)}
            </a>
          ) : (
            <span className="rounded-full border border-elevated/40 bg-elevated/10 px-3 py-1 text-xs text-ink">not configured</span>
          )}
          <span className="text-xs">
            {NETWORK.name} · chain {NETWORK.chainId}
          </span>
        </div>
        <nav className="flex gap-4 text-xs">
          <a className="underline-offset-2 hover:underline" href={NETWORK.explorerUrl} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <a className="underline-offset-2 hover:underline" href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>
          <a className="underline-offset-2 hover:underline" href={`${REPO_URL}/tree/main/deployments/mock_feeds`} target="_blank" rel="noreferrer">
            Mock feeds
          </a>
        </nav>
      </div>
      <p className="mt-4 max-w-3xl text-xs leading-relaxed">
        Testnet software. Feeds read by this deployment are synthetic mock fixtures, not statements from any regulator or central bank. Nothing here is financial advice.
      </p>
    </footer>
  );
}
