"""Shared helpers for the AegisMacro direct-mode suite.

The direct harness does not move native value on its own: `value=` is a plain
attribute and `self.balance` is whatever `deal()` set. `World` therefore keeps
an INDEPENDENT ledger of the contract's balance (inflows on payable calls,
outflows on the methods that emit transfers) and re-deals it after every call,
so `World.assert_conserved()` really does compare the contract's own bucket
accounting against a second set of books.
"""

import json
import os
import re
import sys
from pathlib import Path

import pytest
from gltest.direct.loader import create_address

# Studio Next runs GenVM v0.3.0-rc7 and only knows the v0.3 runner named in the
# contract header; genvm-manager v0.6.0-rc5 ships it (rc10 does not). Pin it so the harness never resolves "latest".
os.environ.setdefault("GENVM_VERSION", "v0.6.0-rc5")

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = str(ROOT / "contracts" / "aegis_macro.py")
FEEDS_DIR = ROOT / "deployments" / "mock_feeds"

ATTO = 10**18
BOND = ATTO // 5  # 0.2 GEN, the protocol floor
DAY = 24 * 3600
YEAR = 365 * DAY
SHA = "0123456789abcdef0123456789abcdef01234567"
SHA2 = "fedcba9876543210fedcba9876543210fedcba98"

BASE_A = f"https://raw.githubusercontent.com/moltaphet/AegisMacro/{SHA}/deployments/mock_feeds/a/"
BASE_B = f"https://cdn.jsdelivr.net/gh/moltaphet/AegisMacro@{SHA}/deployments/mock_feeds/b/"
BASE_C = f"https://raw.githack.com/moltaphet/AegisMacro/{SHA}/deployments/mock_feeds/c/"
BASES = (BASE_A, BASE_B, BASE_C)

T0 = "2026-10-01T00:00:00Z"
T0_TS = 1790812800  # 2026-10-01T00:00:00Z

NORMAL, ELEVATED, CRITICAL = 0, 1, 2
REJECTED, VERIFIED, QUORUM_FAILURE = 0, 1, 2
TIERS = {
    NORMAL: {"max_ltv_bps": 8000, "base_borrow_rate_bps": 400, "reserve_factor_bps": 1000},
    ELEVATED: {"max_ltv_bps": 7000, "base_borrow_rate_bps": 750, "reserve_factor_bps": 2000},
    CRITICAL: {"max_ltv_bps": 5000, "base_borrow_rate_bps": 1200, "reserve_factor_bps": 4000},
}


def hex_of(addr) -> str:
    """Canonical lowercase 0x-hex for a harness address."""
    if isinstance(addr, (bytes, bytearray)):
        return "0x" + bytes(addr).hex()
    raw = getattr(addr, "as_bytes", None)
    if raw is not None:
        return "0x" + bytes(raw).hex()
    return str(addr).lower()


def iso_at(seconds_after_t0: int) -> str:
    from datetime import datetime, timedelta, timezone

    base = datetime(2026, 10, 1, tzinfo=timezone.utc)
    return (base + timedelta(seconds=seconds_after_t0)).strftime("%Y-%m-%dT%H:%M:%SZ")


def feed_doc(epoch: int, level: int, event: str = "EVT-1", **over) -> str:
    doc = {
        "schema": "aegismacro.feed.v1",
        "feed": "TEST",
        "epoch": epoch,
        "risk_level": level,
        "event_id": event,
        "headline": "test",
        "mock": True,
    }
    doc.update(over)
    return json.dumps(doc)


def host_pattern(slot: int, epoch: int) -> str:
    hosts = ("raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com")
    return rf"{re.escape(hosts[slot])}/.*epoch_{epoch}\.json$"


class Feeds:
    """Declarative web mocks for the three registered mirrors.

    A source spec is one of: ("ok", level[, event]), "404", "410", "500",
    "503", "429", "403", "down" (no mock -> the fetch raises), "garbage",
    "empty", ("raw", status, body), ("doc", {...overrides})."""

    def __init__(self, vm):
        self.vm = vm

    def serve(self, epoch: int, a, b, c):
        for slot, spec in enumerate((a, b, c)):
            self._one(slot, epoch, spec)

    def all_agree(self, epoch: int, level: int, event: str = "EVT-1"):
        self.serve(epoch, ("ok", level, event), ("ok", level, event), ("ok", level, event))

    def _one(self, slot: int, epoch: int, spec):
        pat = host_pattern(slot, epoch)
        if spec == "down":
            return
        if isinstance(spec, tuple) and spec[0] == "ok":
            level = spec[1]
            event = spec[2] if len(spec) > 2 else "EVT-1"
            self.vm.mock_web(pat, {"status": 200, "body": feed_doc(epoch, level, event)})
        elif isinstance(spec, tuple) and spec[0] == "raw":
            self.vm.mock_web(pat, {"status": spec[1], "body": spec[2]})
        elif isinstance(spec, tuple) and spec[0] == "doc":
            base = {"schema": "aegismacro.feed.v1", "feed": "T", "epoch": epoch, "risk_level": 1, "event_id": "EVT-1"}
            base.update(spec[1])
            body = json.dumps({k: v for k, v in base.items() if v is not None})
            self.vm.mock_web(pat, {"status": 200, "body": body})
        elif spec == "garbage":
            self.vm.mock_web(pat, {"status": 200, "body": "<html>not json</html>"})
        elif spec == "empty":
            self.vm.mock_web(pat, {"status": 200, "body": ""})
        elif isinstance(spec, str) and spec.isdigit():
            self.vm.mock_web(pat, {"status": int(spec), "body": "error"})
        else:
            raise ValueError(f"unknown feed spec {spec!r}")


class World:
    """A deployed AegisMacro plus an independent balance ledger."""

    OUTFLOW_FROM_ARG = ("borrow", "withdraw")
    OUTFLOW_FROM_RESULT = ("claim_payout", "withdraw_liquidity")

    def __init__(self, vm, deploy):
        self.vm = vm
        self.deploy = deploy
        self.gov = create_address("governor")
        self.alice = create_address("alice")
        self.bob = create_address("bob")
        self.carol = create_address("carol")
        self.watch = create_address("watchtower")
        self.watch2 = create_address("watchtower2")
        self.lp = create_address("liquidity_provider")
        self.ops = [create_address("operator_a"), create_address("operator_b"), create_address("operator_c")]
        self.feeds = Feeds(vm)
        self.balance = 0
        self.c = None
        self.clock = 0
        self.vm.warp(T0)

    # -- deployment --------------------------------------------------------
    def deployed(self, bond=BOND, bases=BASES, ops=None, sender=None):
        self.vm.sender = sender or self.gov
        ops = ops or [hex_of(o) for o in self.ops]
        self.c = self.deploy(CONTRACT, bases[0], bases[1], bases[2], ops[0], ops[1], ops[2], bond)
        self.balance = 0
        self._sync_balance()
        return self.c

    def _sync_balance(self):
        self.vm.deal(self.vm._contract_address, self.balance)

    # -- time --------------------------------------------------------------
    def warp_to(self, seconds_after_t0: int):
        self.clock = seconds_after_t0
        self.vm.warp(iso_at(seconds_after_t0))

    def advance(self, seconds: int):
        self.warp_to(self.clock + seconds)

    # -- calling -----------------------------------------------------------
    def tx(self, sender, method: str, *args, value: int = 0):
        """Run a write call as `sender`, tracking native value in/out."""
        self.vm.sender = sender
        self.vm.value = value
        try:
            result = getattr(self.c, method)(*args)
        finally:
            self.vm.value = 0
        self.balance += value
        if method in self.OUTFLOW_FROM_ARG:
            self.balance -= int(args[0])
        elif method in self.OUTFLOW_FROM_RESULT:
            self.balance -= int(result)
        self._sync_balance()
        return result

    def view(self, method: str, *args):
        return getattr(self.c, method)(*args)

    def revert_msg(self, sender, method: str, *args, value: int = 0, message: str):
        with self.vm.expect_revert(message):
            self.tx(sender, method, *args, value=value)

    # -- watchtower helpers ------------------------------------------------
    def report(self, epoch: int, level: int, sender=None, value: int = BOND):
        return self.tx(sender or self.watch, "report_risk", epoch, level, value=value)

    def set_tier(self, level: int, epoch: int | None = None):
        """Drive the real consensus path to move the active tier."""
        epoch = epoch or int(self.view("get_risk_status")["last_applied_epoch"]) + 1
        self.feeds.all_agree(epoch, level)
        out = self.report(epoch, level)
        assert out["verdict"] == VERIFIED
        return out

    def at_epoch(self, applied: int):
        """Start from a world where epochs 1..applied have already been verified.

        report_risk accepts only applied + 1, so tests of a later fixture epoch
        cannot reach it through the public API when an earlier epoch is
        deliberately unresolvable (fixture epoch 6). Direct mode lets a test set
        the counter itself; the contract's own sequencing logic is unchanged."""
        self.c.risk_epoch = applied
        return self

    # -- accounting --------------------------------------------------------
    def state(self) -> dict:
        return self.view("get_protocol_state")

    def assert_conserved(self):
        s = self.state()
        assert s["solvent"] is True
        assert int(s["contract_balance_wei"]) == self.balance
        assert int(s["tracked_wei"]) == self.balance, "bucket sum drifted from the independent ledger"

    # -- lending conveniences ---------------------------------------------
    def seed(self, amount=ATTO, who=None):
        return self.tx(who or self.lp, "seed_liquidity", value=amount)

    def deposit(self, who, amount):
        return self.tx(who, "deposit_collateral", value=amount)

    def position(self, who):
        return self.view("get_position", hex_of(who))


@pytest.fixture
def world(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    w.deployed()
    return w


@pytest.fixture
def funded(world):
    """A world with 10 GEN of seeded liquidity."""
    world.seed(10 * ATTO)
    return world


def pytest_sessionstart(session):  # noqa: ARG001
    # keep the contract importable for the static float audit
    sys.path.insert(0, str(ROOT))
