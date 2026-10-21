import { Card } from "./ui";

const CARDS = [
  {
    eyebrow: "01 · Ingest",
    title: "Three hosts, no user URLs",
    body: "Watchtowers never pass a link. The contract reads a registry of three mirrors on three different CDNs, each pinned to a 40-hex commit, operated by three distinct keys. Changing any slot waits out a 7-day timelock.",
  },
  {
    eyebrow: "02 · Consensus",
    title: "2-of-3, outage-safe",
    body: "Two sources that agree on the same record make a quorum. Fewer than two answers, or an outage that could still complete a quorum, returns QUORUM_FAILURE: retry, bond intact. One source confirming while the others 404 is CDN lag, not fraud: no slash. Epochs must be reported strictly in order.",
  },
  {
    eyebrow: "03 · Skin in the game",
    title: "Bonds, slashing, insurance",
    body: "Every report stakes at least 0.2 GEN. A report that two independent sources contradict, or that two sources say never happened while none confirms it, forfeits 100% of the bond into a locked insurance reserve the governor cannot touch.",
  },
  {
    eyebrow: "04 · Circuit breaker",
    title: "Integer-BPS risk tiers",
    body: "A verified shift moves the pool between NORMAL, ELEVATED and CRITICAL. Max LTV, borrow rate and reserve factor are basis-point integers, enforced in exact integer arithmetic. No floats, no dust.",
  },
];

export function ProtocolExplainer() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CARDS.map((c) => (
        <Card key={c.title} eyebrow={c.eyebrow} title={c.title}>
          <p className="text-sm leading-relaxed text-ink-soft">{c.body}</p>
        </Card>
      ))}
    </div>
  );
}
