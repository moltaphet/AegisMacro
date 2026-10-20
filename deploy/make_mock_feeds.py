"""Generate the commit-pinned mock macro/regulatory feed fixtures.

These are SYNTHETIC test documents (every record carries "mock": true). They are
not statements from any regulator or central bank. Each scenario is one epoch:

  epoch 1  all three mirrors agree: ELEVATED          -> VERIFIED for claim 1
  epoch 2  all three mirrors agree: CRITICAL          -> VERIFIED for claim 2
  epoch 3  all three mirrors agree: NORMAL            -> VERIFIED for claim 0
  epoch 4  A+B agree ELEVATED, C lags (no file, 404)  -> VERIFIED for claim 1
  epoch 5  A+B+C NORMAL except C says CRITICAL        -> NORMAL quorum; CRITICAL claim REJECTED
  epoch 6  A=CRITICAL B=ELEVATED C=NORMAL (3-way split)-> QUORUM_FAILURE for any claim
  epoch 7  A+B publish a CRITICAL record, C malformed -> VERIFIED for claim 2 (bad body ignored)
  epoch 8  only A published (B and C return 404)      -> REJECTED: two 404s are a "no such event" quorum
  any other epoch: no file anywhere -> three 404s     -> REJECTED (fabricated event)
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "deployments" / "mock_feeds"
FEEDS = {"a": "SEC_REGULATORY_MIRROR", "b": "CENTRAL_BANK_MACRO_MIRROR", "c": "GLOBAL_ECONOMIC_WIRE_MIRROR"}
HEADLINES = {
    (1, 1): "MOCK: regulator signals heightened scrutiny of leveraged lending",
    (2, 2): "MOCK: emergency policy-rate action and systemic funding stress",
    (3, 0): "MOCK: conditions normalise, scrutiny lifted",
    (4, 1): "MOCK: tightening guidance published, second wire delayed",
    (5, 0): "MOCK: markets stable, no adverse action",
    (6, 0): "MOCK: conflicting signals across mirrors",
    (7, 2): "MOCK: enforcement action against a major stablecoin issuer",
    (8, 1): "MOCK: single-source bulletin awaiting corroboration",
}


def record(feed: str, epoch: int, level: int, event: str) -> dict:
    return {
        "schema": "aegismacro.feed.v1",
        "feed": FEEDS[feed],
        "epoch": epoch,
        "risk_level": level,
        "event_id": event,
        "headline": HEADLINES.get((epoch, level), f"MOCK: epoch {epoch} bulletin"),
        "published_at": f"2026-10-{epoch:02d}T09:00:00Z",
        "mock": True,
    }


# epoch -> {feed: (level, event_id)}  (absent feed == no file == HTTP 404)
SCENARIOS = {
    1: {"a": (1, "MOCK-E01"), "b": (1, "MOCK-E01"), "c": (1, "MOCK-E01")},
    2: {"a": (2, "MOCK-E02"), "b": (2, "MOCK-E02"), "c": (2, "MOCK-E02")},
    3: {"a": (0, "MOCK-E03"), "b": (0, "MOCK-E03"), "c": (0, "MOCK-E03")},
    4: {"a": (1, "MOCK-E04"), "b": (1, "MOCK-E04")},
    5: {"a": (0, "MOCK-E05"), "b": (0, "MOCK-E05"), "c": (2, "MOCK-E05X")},
    6: {"a": (2, "MOCK-E06A"), "b": (1, "MOCK-E06B"), "c": (0, "MOCK-E06C")},
    7: {"a": (2, "MOCK-E07"), "b": (2, "MOCK-E07")},
    8: {"a": (1, "MOCK-E08")},
}


def main() -> None:
    for feed in FEEDS:
        (ROOT / feed).mkdir(parents=True, exist_ok=True)
        for old in (ROOT / feed).glob("epoch_*.json"):
            old.unlink()
    for epoch, sources in SCENARIOS.items():
        for feed, (level, event) in sources.items():
            path = ROOT / feed / f"epoch_{epoch}.json"
            path.write_text(json.dumps(record(feed, epoch, level, event), indent=2) + "\n")
    # epoch 7: mirror C is reachable but serves a malformed (unusable) body
    (ROOT / "c" / "epoch_7.json").write_text("{ this is not valid json\n")
    print("wrote", sum(1 for _ in ROOT.rglob("epoch_*.json")), "fixtures")


if __name__ == "__main__":
    main()
