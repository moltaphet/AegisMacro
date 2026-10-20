# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

import hashlib
import json
import typing
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import genlayer as gl
from genlayer import Address, u256
from genlayer.storage import TreeMap

# genvm-lint matches the bare name `allow_storage` on storage dataclasses.
allow_storage = gl.storage.allow

# --- Error classification ---------------------------------------------------
ERR_UNAUTHORIZED = "ERR_UNAUTHORIZED"
ERR_BOND = "ERR_INSUFFICIENT_BOND"
ERR_PARAM = "ERR_INVALID_PARAM"
ERR_STATE = "ERR_INVALID_STATE"
ERR_EPOCH = "ERR_EPOCH_OUT_OF_RANGE"
ERR_FEED = "ERR_INVALID_FEED_SOURCE"
ERR_TIMELOCK = "ERR_TIMELOCK"
ERR_LTV = "ERR_LTV_EXCEEDED"
ERR_LIQUIDITY = "ERR_INSUFFICIENT_LIQUIDITY"
ERR_NO_DEBT = "ERR_NO_DEBT"
ERR_NO_BALANCE = "ERR_NO_CLAIMABLE_BALANCE"
ERR_CONSENSUS = "[CONSENSUS_PAYLOAD]"

# --- Risk tiers (integer basis points, 10000 == 100%) -----------------------
RISK_LEVEL_NORMAL = 0
RISK_LEVEL_ELEVATED = 1
RISK_LEVEL_CRITICAL = 2
RISK_LEVEL_NONE = -1  # "no agreed tier" in a consensus payload; never stored as the active tier
RISK_NAMES = ("RISK_LEVEL_NORMAL", "RISK_LEVEL_ELEVATED", "RISK_LEVEL_CRITICAL")
# (max_ltv_bps, base_borrow_rate_bps, reserve_factor_bps)
RISK_TIERS = (
    (8000, 400, 1000),
    (7000, 750, 2000),
    (5000, 1200, 4000),
)
BPS = 10000

# --- Verdicts ---------------------------------------------------------------
VERDICT_REJECTED = 0  # >= 2 sources contradict the report or both 404: bond slashed
VERDICT_VERIFIED = 1  # >= 2 sources agree on the claimed tier: shift applied
VERDICT_QUORUM_FAILURE = 2  # inconclusive / outage / lag: retryable, bond intact
VERDICT_NAMES = ("REJECTED_REPORT", "VERIFIED_RISK_SHIFT", "QUORUM_FAILURE")

# --- Feed registry ----------------------------------------------------------
SLOT_COUNT = 3
QUORUM = 2
SLOT_LABELS = ("SEC_REGULATORY_MIRROR", "CENTRAL_BANK_MACRO_MIRROR", "GLOBAL_ECONOMIC_WIRE_MIRROR")
SLOT_HOSTS = ("raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com")
# Each slot may only point into this repository, and only at a 40-hex commit
# SHA (immutable), never a branch or tag that could be rewritten under us.
SLOT_PREFIXES = ("/moltaphet/AegisMacro/", "/gh/moltaphet/AegisMacro@", "/moltaphet/AegisMacro/")
MAX_FEED_URL_LEN = 300
MAX_FEED_BYTES = 8192
FEED_SCHEMA = "aegismacro.feed.v1"
URL_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./@"
EVENT_ID_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:"
MAX_EVENT_ID_LEN = 64
HEX_DIGITS = "0123456789abcdef"

SRC_OK = "OK"
SRC_NOT_FOUND = "NOT_FOUND"
SRC_UNUSABLE = "UNUSABLE"

# --- Governance / economics -------------------------------------------------
ATTO = 10**18
MIN_WATCHTOWER_BOND = ATTO // 5  # 0.2 GEN
ROTATION_DELAY = 7 * 24 * 3600
ROTATION_EXPIRY = 7 * 24 * 3600  # an executable proposal goes stale this long after its eta
EPOCH_LOOKAHEAD = 16  # an epoch may be at most this far past the last applied one
BOUNTY_BPS = 1000  # 10% of the bond, paid from the reserve pool, only on a real tier change
SECONDS_PER_YEAR = 365 * 24 * 3600
INDEX_ONE = 10**18


def _fail(code: str, msg: str) -> typing.NoReturn:
    raise gl.vm.UserError(f"{code} {msg}")


# ---------------------------------------------------------------------------
# Feed URL registry validation
# ---------------------------------------------------------------------------
def _is_commit_sha(s: str) -> bool:
    if len(s) != 40:
        return False
    for ch in s:
        if ch not in HEX_DIGITS:
            return False
    return True


def _feed_url_problem(slot: int, url: str) -> str:
    """Return "" when `url` is an acceptable base URL for `slot`, else the
    reason. A base URL is a directory: the contract appends epoch_<n>.json."""
    if slot < 0 or slot >= SLOT_COUNT:
        return "slot out of range"
    if not isinstance(url, str) or url == "":
        return "empty url"
    if len(url) > MAX_FEED_URL_LEN:
        return "url too long"
    if not url.isascii() or url != url.strip():
        return "url must be plain ascii"
    try:
        parts = urlsplit(url)
    except ValueError:
        return "unparseable url"
    host = SLOT_HOSTS[slot]
    if parts.scheme != "https":
        return "https required"
    # netloc must be exactly the slot host: rejects userinfo, ports, upper case.
    if parts.netloc != host or parts.hostname != host:
        return f"host must be exactly {host}"
    if parts.query != "" or parts.fragment != "" or "?" in url or "#" in url:
        return "no query or fragment allowed"
    path = parts.path
    for ch in path:
        if ch not in URL_SAFE:
            return "illegal character in path"
    if "//" in path or ".." in path:
        return "path traversal not allowed"
    prefix = SLOT_PREFIXES[slot]
    if not path.startswith(prefix):
        return f"path must start with {prefix}"
    rest = path[len(prefix):]
    sha = rest[:40]
    if not _is_commit_sha(sha):
        return "path must pin a 40-hex lowercase commit sha"
    tail = rest[40:]
    if not tail.startswith("/") or not tail.endswith("/"):
        return "base url must be a directory below the commit"
    return ""


def _epoch_url(base: str, epoch: int) -> str:
    return base + "epoch_" + str(epoch) + ".json"


def _norm_address(hex_str: str) -> str:
    """Canonical lowercase hex for an address argument, or "" when invalid."""
    if not isinstance(hex_str, str) or len(hex_str) != 42 or not hex_str.startswith("0x"):
        return ""
    body = hex_str[2:].lower()
    for ch in body:
        if ch not in HEX_DIGITS:
            return ""
    return "0x" + body


def _valid_event_id(ev) -> bool:
    if not isinstance(ev, str) or ev == "" or len(ev) > MAX_EVENT_ID_LEN:
        return False
    for ch in ev:
        if ch not in EVENT_ID_SAFE:
            return False
    return True


# ---------------------------------------------------------------------------
# Feed reading + the 5-step aggregate (pure functions, no storage)
# ---------------------------------------------------------------------------
def _unusable() -> dict:
    return {"status": SRC_UNUSABLE, "risk_level": RISK_LEVEL_NONE, "event_id": ""}


def _fetch_source(url: str, epoch: int) -> dict:
    """Read one feed mirror and classify it. Never raises and never touches
    storage. 404/410 is an explicit "no such record" (NOT_FOUND); every other
    non-2xx, every network fault and every malformed or mismatched body is
    UNUSABLE, which can never contribute to a slash."""
    try:
        res = gl.nondet.web.get(url)
    except Exception:
        return _unusable()
    status = getattr(res, "status", None)
    if status is None:
        status = getattr(res, "status_code", None)
    if isinstance(status, bool) or not isinstance(status, int):
        return _unusable()
    if status == 404 or status == 410:
        return {"status": SRC_NOT_FOUND, "risk_level": RISK_LEVEL_NONE, "event_id": ""}
    if not (200 <= status < 300):
        return _unusable()
    try:
        body = res.body
        if isinstance(body, (bytes, bytearray)):
            if len(body) > MAX_FEED_BYTES:
                return _unusable()
            body = bytes(body).decode("utf-8")
        elif isinstance(body, str):
            if len(body) > MAX_FEED_BYTES:
                return _unusable()
        else:
            return _unusable()
        doc = json.loads(body)
    except Exception:
        return _unusable()
    if not isinstance(doc, dict) or doc.get("schema") != FEED_SCHEMA:
        return _unusable()
    rec_epoch = doc.get("epoch")
    level = doc.get("risk_level")
    event_id = doc.get("event_id")
    if type(rec_epoch) is not int or rec_epoch != epoch:
        return _unusable()
    if type(level) is not int or level < 0 or level > 2:
        return _unusable()
    if not _valid_event_id(event_id):
        return _unusable()
    return {"status": SRC_OK, "risk_level": level, "event_id": event_id}


def _canon_observation(o) -> tuple:
    """(status, level, event_id) with anything malformed collapsed to UNUSABLE."""
    if not isinstance(o, dict):
        return (SRC_UNUSABLE, RISK_LEVEL_NONE, "")
    st = o.get("status")
    if st == SRC_NOT_FOUND:
        return (SRC_NOT_FOUND, RISK_LEVEL_NONE, "")
    if st == SRC_OK:
        lvl = o.get("risk_level")
        ev = o.get("event_id")
        if type(lvl) is int and 0 <= lvl <= 2 and _valid_event_id(ev):
            return (SRC_OK, lvl, ev)
    return (SRC_UNUSABLE, RISK_LEVEL_NONE, "")


def _record_hash(epoch: int, level: int, event_id: str) -> str:
    return hashlib.sha256(f"{epoch}|{level}|{event_id}".encode("utf-8")).hexdigest()


def _aggregate(observations: list, claimed_level: int, epoch: int) -> dict:
    """The fault-tolerant 5-step rule. Returns the 4-field consensus payload
    {"verdict", "risk_level", "source_count", "announcement_hash"}.

      1. Classify every source: OK(level, event) / NOT_FOUND / UNUSABLE.
      2. Tally identical OK records; two sources that agree on the same
         (level, event) are a quorum.
      3. Quorum on the claimed tier -> VERIFIED_RISK_SHIFT (1).
      4. Quorum on a different tier, or >= 2 NOT_FOUND (fabricated event)
         -> REJECTED_REPORT (0). The only two ways to lose a bond.
      5. Anything else (fewer than 2 responses, 1 OK + 1 404 + 1 outage where
         the down source could still complete a quorum, a three-way split,
         malformed bodies) -> QUORUM_FAILURE (2): retryable, bond intact.

    source_count is the number of definitive responses (OK or NOT_FOUND).
    risk_level is RISK_LEVEL_NONE (-1) unless a record quorum exists."""
    canon = [_canon_observation(o) for o in observations]
    votes = {}
    not_found = 0
    ok = 0
    for st, lvl, ev in canon:
        if st == SRC_OK:
            ok += 1
            key = (lvl, ev)
            votes[key] = votes.get(key, 0) + 1
        elif st == SRC_NOT_FOUND:
            not_found += 1
    responded = ok + not_found

    best_key = None
    best_n = 0
    for key in sorted(votes):
        if votes[key] > best_n:
            best_key = key
            best_n = votes[key]
    if best_key is not None and best_n >= QUORUM:
        lvl, ev = best_key
        verdict = VERDICT_VERIFIED if lvl == claimed_level else VERDICT_REJECTED
        return {
            "verdict": verdict,
            "risk_level": lvl,
            "source_count": responded,
            "announcement_hash": _record_hash(epoch, lvl, ev),
        }
    if not_found >= QUORUM:
        return {
            "verdict": VERDICT_REJECTED,
            "risk_level": RISK_LEVEL_NONE,
            "source_count": responded,
            "announcement_hash": hashlib.sha256(f"{epoch}|NOT_FOUND".encode("utf-8")).hexdigest(),
        }
    return {
        "verdict": VERDICT_QUORUM_FAILURE,
        "risk_level": RISK_LEVEL_NONE,
        "source_count": responded,
        "announcement_hash": "",
    }


def _payload_ok(p) -> bool:
    """Shape and internal-consistency check on a consensus payload. Applied to
    the leader's result by every validator and again before settlement."""
    if not isinstance(p, dict) or len(p) != 4:
        return False
    for k in ("verdict", "risk_level", "source_count", "announcement_hash"):
        if k not in p:
            return False
    v = p["verdict"]
    lvl = p["risk_level"]
    n = p["source_count"]
    h = p["announcement_hash"]
    if type(v) is not int or type(lvl) is not int or type(n) is not int or not isinstance(h, str):
        return False
    if v < 0 or v > 2 or lvl < -1 or lvl > 2 or n < 0 or n > SLOT_COUNT:
        return False
    if v == VERDICT_QUORUM_FAILURE:
        return lvl == RISK_LEVEL_NONE and h == ""
    if n < QUORUM or len(h) != 64:
        return False
    for ch in h:
        if ch not in HEX_DIGITS:
            return False
    if v == VERDICT_VERIFIED:
        return lvl >= 0
    return True


# ---------------------------------------------------------------------------
# Storage records
# ---------------------------------------------------------------------------
@allow_storage
@dataclass
class Report:
    watchtower: Address
    epoch: u256
    claimed_level: u256
    verdict: u256
    quorum_present: bool
    quorum_level: u256
    source_count: u256
    announcement_hash: str
    bond: u256
    bounty: u256
    slashed: u256
    level_changed: bool
    created_at: u256


class AegisMacro(gl.contract.Contract):
    # governance
    governor: Address
    pending_governor: str  # "" == none
    watchtower_bond: u256
    # feed registry: slot -> value
    feed_base: TreeMap[u256, str]
    feed_operator: TreeMap[u256, str]
    rot_base: TreeMap[u256, str]
    rot_operator: TreeMap[u256, str]
    rot_eta: TreeMap[u256, u256]  # 0 == no rotation pending
    # active risk state
    risk_level: u256
    risk_epoch: u256  # highest epoch already applied (replay / stale-feed guard)
    risk_updated_at: u256
    shift_count: u256
    # watchtower reports
    reports: TreeMap[u256, Report]
    report_count: u256
    wt_verified: TreeMap[str, u256]
    wt_rejected: TreeMap[str, u256]
    wt_inconclusive: TreeMap[str, u256]
    count_verified: u256
    count_rejected: u256
    count_inconclusive: u256
    # pull-pattern balances
    claimable: TreeMap[str, u256]
    total_claimable: u256
    # accounting buckets (every wei lives in exactly one; see _tracked)
    insurance_reserve: u256  # slashed bonds, locked forever
    reserve_pool: u256  # reserve-factor cut of interest; funds watchtower bounties
    pool_cash: u256  # lendable liquidity
    total_collateral: u256
    total_borrows: u256
    total_shares: u256
    # lending positions
    lp_shares: TreeMap[str, u256]
    collateral: TreeMap[str, u256]
    debt: TreeMap[str, u256]
    principal: TreeMap[str, u256]
    debt_index: TreeMap[str, u256]
    borrow_index: u256
    index_updated_at: u256

    def __init__(
        self,
        feed_base_a: str,
        feed_base_b: str,
        feed_base_c: str,
        operator_a: str,
        operator_b: str,
        operator_c: str,
        watchtower_bond: u256,
    ):
        if int(watchtower_bond) < MIN_WATCHTOWER_BOND:
            _fail(ERR_BOND, "watchtower_bond below 0.2 GEN floor")
        self.governor = gl.message.sender_address
        self.pending_governor = ""
        self.watchtower_bond = watchtower_bond
        bases = [feed_base_a, feed_base_b, feed_base_c]
        ops = [_norm_address(operator_a), _norm_address(operator_b), _norm_address(operator_c)]
        gov = gl.message.sender_address.as_hex.lower()
        for slot in range(SLOT_COUNT):
            problem = _feed_url_problem(slot, bases[slot])
            if problem != "":
                _fail(ERR_FEED, f"slot {slot}: {problem}")
            if ops[slot] == "":
                _fail(ERR_PARAM, f"slot {slot}: operator is not a 0x address")
            if ops[slot] == gov:
                _fail(ERR_FEED, "governor cannot operate a feed")
        hosts = [SLOT_HOSTS[0], SLOT_HOSTS[1], SLOT_HOSTS[2]]
        if not (len(set(hosts)) == SLOT_COUNT and len(set(ops)) == SLOT_COUNT):
            _fail(ERR_FEED, "feed hosts and operators must all be distinct")
        for slot in range(SLOT_COUNT):
            self.feed_base[slot] = bases[slot]
            self.feed_operator[slot] = ops[slot]
            self.rot_base[slot] = ""
            self.rot_operator[slot] = ""
            self.rot_eta[slot] = 0
        self.risk_level = RISK_LEVEL_NORMAL
        self.risk_epoch = 0
        self.risk_updated_at = self._now()
        self.shift_count = 0
        self.report_count = 0
        self.count_verified = 0
        self.count_rejected = 0
        self.count_inconclusive = 0
        self.total_claimable = 0
        self.insurance_reserve = 0
        self.reserve_pool = 0
        self.pool_cash = 0
        self.total_collateral = 0
        self.total_borrows = 0
        self.total_shares = 0
        self.borrow_index = INDEX_ONE
        self.index_updated_at = self._now()

    # ------------------------------------------------------------------ views
    @gl.public.view
    def get_risk_status(self) -> dict:
        lvl = int(self.risk_level)
        ltv, rate, rf = RISK_TIERS[lvl]
        return {
            "risk_level": lvl,
            "risk_name": RISK_NAMES[lvl],
            "max_ltv_bps": ltv,
            "base_borrow_rate_bps": rate,
            "reserve_factor_bps": rf,
            "last_applied_epoch": int(self.risk_epoch),
            "updated_at": int(self.risk_updated_at),
            "shift_count": int(self.shift_count),
        }

    @gl.public.view
    def get_risk_tiers(self) -> list:
        out = []
        for lvl in range(3):
            ltv, rate, rf = RISK_TIERS[lvl]
            out.append(
                {
                    "risk_level": lvl,
                    "risk_name": RISK_NAMES[lvl],
                    "max_ltv_bps": ltv,
                    "base_borrow_rate_bps": rate,
                    "reserve_factor_bps": rf,
                }
            )
        return out

    @gl.public.view
    def get_feed_sources(self) -> list:
        out = []
        for slot in range(SLOT_COUNT):
            eta = int(self.rot_eta[slot])
            out.append(
                {
                    "slot": slot,
                    "label": SLOT_LABELS[slot],
                    "host": SLOT_HOSTS[slot],
                    "base_url": self.feed_base[slot],
                    "operator": self.feed_operator[slot],
                    "pending_base_url": self.rot_base[slot],
                    "pending_operator": self.rot_operator[slot],
                    "rotation_eta": eta,
                }
            )
        return out

    @gl.public.view
    def get_protocol_state(self) -> dict:
        tracked = self._tracked()
        bal = int(self.balance)
        lvl = int(self.risk_level)
        ltv, rate, rf = RISK_TIERS[lvl]
        return {
            "governor": self.governor.as_hex.lower(),
            "pending_governor": self.pending_governor,
            "watchtower_bond_wei": str(self.watchtower_bond),
            "risk_level": lvl,
            "risk_name": RISK_NAMES[lvl],
            "max_ltv_bps": ltv,
            "base_borrow_rate_bps": rate,
            "reserve_factor_bps": rf,
            "last_applied_epoch": int(self.risk_epoch),
            "shift_count": int(self.shift_count),
            "report_count": int(self.report_count),
            "verified_reports": int(self.count_verified),
            "rejected_reports": int(self.count_rejected),
            "inconclusive_reports": int(self.count_inconclusive),
            "insurance_reserve_wei": str(self.insurance_reserve),
            "reserve_pool_wei": str(self.reserve_pool),
            "pool_cash_wei": str(self.pool_cash),
            "total_collateral_wei": str(self.total_collateral),
            "total_borrows_wei": str(self.total_borrows),
            "total_shares": str(self.total_shares),
            "total_claimable_wei": str(self.total_claimable),
            "borrow_index": str(self.borrow_index),
            "contract_balance_wei": str(bal),
            "tracked_wei": str(tracked),
            "solvent": bal >= tracked,
        }

    @gl.public.view
    def get_report_count(self) -> int:
        return int(self.report_count)

    @gl.public.view
    def get_report(self, report_id: u256) -> dict:
        if report_id not in self.reports:
            _fail(ERR_STATE, "unknown report")
        r = self.reports[report_id]
        return {
            "report_id": int(report_id),
            "watchtower": r.watchtower.as_hex.lower(),
            "epoch": int(r.epoch),
            "claimed_level": int(r.claimed_level),
            "verdict": int(r.verdict),
            "verdict_name": VERDICT_NAMES[int(r.verdict)],
            "quorum_present": r.quorum_present,
            "quorum_level": int(r.quorum_level),
            "source_count": int(r.source_count),
            "announcement_hash": r.announcement_hash,
            "bond_wei": str(r.bond),
            "bounty_wei": str(r.bounty),
            "slashed_wei": str(r.slashed),
            "level_changed": r.level_changed,
            "created_at": int(r.created_at),
        }

    @gl.public.view
    def get_watchtower(self, addr_hex: str) -> dict:
        key = _norm_address(addr_hex)
        if key == "":
            _fail(ERR_PARAM, "address must be 0x + 40 hex")
        return {
            "address": key,
            "verified": self._get(self.wt_verified, key),
            "rejected": self._get(self.wt_rejected, key),
            "inconclusive": self._get(self.wt_inconclusive, key),
            "claimable_wei": str(self._get(self.claimable, key)),
        }

    @gl.public.view
    def claimable_of(self, addr_hex: str) -> str:
        key = _norm_address(addr_hex)
        if key == "":
            _fail(ERR_PARAM, "address must be 0x + 40 hex")
        return str(self._get(self.claimable, key))

    @gl.public.view
    def whoami(self) -> str:
        return gl.message.sender_address.as_hex.lower()

    @gl.public.view
    def is_valid_feed_url(self, slot: u256, url: str) -> str:
        """"" when `url` would be accepted for `slot`, otherwise the reason."""
        return _feed_url_problem(int(slot), url)

    @gl.public.view
    def preview_aggregate(self, observations_json: str, claimed_level: u256, epoch: u256) -> dict:
        """Dry-run the 5-step aggregate on caller-supplied observations, e.g.
        [{"status":"OK","risk_level":1,"event_id":"X"},{"status":"NOT_FOUND"},
        {"status":"UNUSABLE"}]. Pure: reads no feed and no storage."""
        try:
            obs = json.loads(observations_json)
        except Exception:
            _fail(ERR_PARAM, "observations_json is not JSON")
        if not isinstance(obs, list) or len(obs) != SLOT_COUNT:
            _fail(ERR_PARAM, "exactly 3 observations required")
        if int(claimed_level) > 2:
            _fail(ERR_PARAM, "claimed_level must be 0..2")
        return _aggregate(obs, int(claimed_level), int(epoch))

    @gl.public.view
    def get_position(self, addr_hex: str) -> dict:
        key = _norm_address(addr_hex)
        if key == "":
            _fail(ERR_PARAM, "address must be 0x + 40 hex")
        lvl = int(self.risk_level)
        max_ltv = RISK_TIERS[lvl][0]
        coll = self._get(self.collateral, key)
        debt_now = self._debt_at(key, self._index_at(self._now()))
        princ = self._get(self.principal, key)
        capacity = (coll * max_ltv) // BPS
        borrowable = capacity - debt_now if capacity > debt_now else 0
        if borrowable > int(self.pool_cash):
            borrowable = int(self.pool_cash)
        ltv_bps = 0
        if coll > 0:
            ltv_bps = (debt_now * BPS) // coll
        shares = self._get(self.lp_shares, key)
        return {
            "address": key,
            "collateral_wei": str(coll),
            "debt_wei": str(debt_now),
            "principal_wei": str(princ),
            "interest_wei": str(debt_now - princ if debt_now > princ else 0),
            "current_ltv_bps": ltv_bps,
            "max_ltv_bps": max_ltv,
            "borrowable_wei": str(borrowable),
            "over_limit": debt_now * BPS > coll * max_ltv,
            "lp_shares": str(shares),
            "lp_value_wei": str(self._shares_value(shares)),
        }

    # --------------------------------------------------------- watchtower desk
    @gl.public.write.payable
    def report_risk(self, epoch: u256, claimed_level: u256) -> dict:
        """Stake `value >= watchtower_bond` and propose that the feeds' record
        for `epoch` puts the protocol at `claimed_level`. The contract reads
        the three registered mirrors itself; the reporter supplies no URL."""
        bond = int(gl.message.value)
        if bond < int(self.watchtower_bond):
            _fail(ERR_BOND, "stake at least the watchtower bond")
        ep = int(epoch)
        claim = int(claimed_level)
        if claim > 2:
            _fail(ERR_PARAM, "claimed_level must be 0..2")
        last = int(self.risk_epoch)
        if ep < 1 or ep <= last or ep > last + EPOCH_LOOKAHEAD:
            _fail(ERR_EPOCH, f"epoch must be in {last + 1}..{last + EPOCH_LOOKAHEAD}")

        bases = [self.feed_base[0], self.feed_base[1], self.feed_base[2]]
        payload = self._resolve(bases, ep, claim)
        if not _payload_ok(payload):
            _fail(ERR_CONSENSUS, "malformed consensus payload")
        if payload["verdict"] == VERDICT_VERIFIED and payload["risk_level"] != claim:
            _fail(ERR_CONSENSUS, "verified payload disagrees with the claim")

        verdict = payload["verdict"]
        quorum_level = payload["risk_level"]
        sender = gl.message.sender_address
        key = sender.as_hex.lower()
        now = self._now()
        old_level = int(self.risk_level)
        bounty = 0
        slashed = 0
        changed = False

        if verdict == VERDICT_VERIFIED:
            # Accrue interest at the OLD tier's rate before the tier changes.
            self._accrue_global(now)
            changed = quorum_level != old_level
            self.risk_level = quorum_level
            self.risk_epoch = ep
            self.risk_updated_at = now
            if changed:
                self.shift_count = int(self.shift_count) + 1
                want = (bond * BOUNTY_BPS) // BPS
                bounty = want if want < int(self.reserve_pool) else int(self.reserve_pool)
                self.reserve_pool = int(self.reserve_pool) - bounty
            self._credit(key, bond + bounty)
            self._bump(self.wt_verified, key)
            self.count_verified = int(self.count_verified) + 1
        elif verdict == VERDICT_REJECTED:
            slashed = bond
            self.insurance_reserve = int(self.insurance_reserve) + bond
            self._bump(self.wt_rejected, key)
            self.count_rejected = int(self.count_rejected) + 1
        else:
            self._credit(key, bond)
            self._bump(self.wt_inconclusive, key)
            self.count_inconclusive = int(self.count_inconclusive) + 1

        rid = int(self.report_count) + 1
        self.report_count = rid
        quorum_present = quorum_level >= 0
        self.reports[rid] = Report(
            watchtower=sender,
            epoch=ep,
            claimed_level=claim,
            verdict=verdict,
            quorum_present=quorum_present,
            quorum_level=quorum_level if quorum_present else 0,
            source_count=payload["source_count"],
            announcement_hash=payload["announcement_hash"],
            bond=bond,
            bounty=bounty,
            slashed=slashed,
            level_changed=changed,
            created_at=now,
        )
        return {
            "report_id": rid,
            "verdict": verdict,
            "verdict_name": VERDICT_NAMES[verdict],
            "risk_level": quorum_level,
            "applied_level": int(self.risk_level),
            "level_changed": changed,
            "source_count": payload["source_count"],
            "announcement_hash": payload["announcement_hash"],
            "bond_wei": str(bond),
            "bounty_wei": str(bounty),
            "slashed_wei": str(slashed),
            "bond_intact": verdict != VERDICT_REJECTED,
        }

    def _resolve(self, bases: list, epoch: int, claimed: int) -> dict:
        """Non-deterministic round. Everything the closures use is a local, so
        no storage is read inside the nondet block."""
        urls = [_epoch_url(b, epoch) for b in bases]

        def leader_fn() -> dict:
            return _aggregate([_fetch_source(u, epoch) for u in urls], claimed, epoch)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            theirs = leaders_res.calldata
            if not _payload_ok(theirs):
                return False
            mine = leader_fn()
            # Agree on the decision, the agreed tier and the exact record the
            # quorum read. source_count may differ by a transient outage.
            return (
                theirs["verdict"] == mine["verdict"]
                and theirs["risk_level"] == mine["risk_level"]
                and theirs["announcement_hash"] == mine["announcement_hash"]
            )

        return gl.vm.run_nondet(leader_fn, validator_fn)

    @gl.public.write
    def claim_payout(self) -> str:
        key = gl.message.sender_address.as_hex.lower()
        amount = self._get(self.claimable, key)
        if amount == 0:
            _fail(ERR_NO_BALANCE, "nothing to claim")
        self.claimable[key] = 0
        self.total_claimable = int(self.total_claimable) - amount
        gl.chain.Account(gl.message.sender_address).emit_transfer(amount, on="finalized")
        return str(amount)

    # -------------------------------------------------------------- governance
    @gl.public.write
    def propose_feed_rotation(self, slot: u256, new_base_url: str, new_operator_hex: str) -> int:
        self._only_governor()
        s = int(slot)
        problem = _feed_url_problem(s, new_base_url)
        if problem != "":
            _fail(ERR_FEED, problem)
        op = _norm_address(new_operator_hex)
        if op == "":
            _fail(ERR_PARAM, "operator is not a 0x address")
        if op == self.governor.as_hex.lower():
            _fail(ERR_FEED, "governor cannot operate a feed")
        self._check_unique_operators(s, op)
        eta = self._now() + ROTATION_DELAY
        self.rot_base[s] = new_base_url
        self.rot_operator[s] = op
        self.rot_eta[s] = eta
        return eta

    @gl.public.write
    def execute_feed_rotation(self, slot: u256) -> None:
        self._only_governor()
        s = int(slot)
        if s >= SLOT_COUNT:
            _fail(ERR_PARAM, "slot out of range")
        eta = int(self.rot_eta[s])
        if eta == 0:
            _fail(ERR_STATE, "no rotation pending")
        now = self._now()
        if now < eta:
            _fail(ERR_TIMELOCK, "7-day timelock still running")
        if now > eta + ROTATION_EXPIRY:
            _fail(ERR_TIMELOCK, "rotation proposal expired; propose again")
        op = self.rot_operator[s]
        self._check_unique_operators(s, op)
        ops = [self.feed_operator[0], self.feed_operator[1], self.feed_operator[2]]
        ops[s] = op
        hosts = [SLOT_HOSTS[0], SLOT_HOSTS[1], SLOT_HOSTS[2]]
        if not (len(set(hosts)) == SLOT_COUNT and len(set(ops)) == SLOT_COUNT):
            _fail(ERR_FEED, "feed hosts and operators must all be distinct")
        self.feed_base[s] = self.rot_base[s]
        self.feed_operator[s] = op
        self.rot_base[s] = ""
        self.rot_operator[s] = ""
        self.rot_eta[s] = 0

    @gl.public.write
    def cancel_feed_rotation(self, slot: u256) -> None:
        self._only_governor()
        s = int(slot)
        if s >= SLOT_COUNT:
            _fail(ERR_PARAM, "slot out of range")
        if int(self.rot_eta[s]) == 0:
            _fail(ERR_STATE, "no rotation pending")
        self.rot_base[s] = ""
        self.rot_operator[s] = ""
        self.rot_eta[s] = 0

    @gl.public.write
    def propose_governor(self, new_governor_hex: str) -> None:
        self._only_governor()
        g = _norm_address(new_governor_hex)
        if g == "":
            _fail(ERR_PARAM, "address must be 0x + 40 hex")
        for slot in range(SLOT_COUNT):
            if self.feed_operator[slot] == g:
                _fail(ERR_FEED, "a feed operator cannot be governor")
        self.pending_governor = g

    @gl.public.write
    def accept_governor(self) -> None:
        pending = self.pending_governor
        if pending == "":
            _fail(ERR_STATE, "no governor handover pending")
        if gl.message.sender_address.as_hex.lower() != pending:
            _fail(ERR_UNAUTHORIZED, "only the proposed governor may accept")
        self.governor = gl.message.sender_address
        self.pending_governor = ""

    # ---------------------------------------------------------- lending sandbox
    @gl.public.write.payable
    def seed_liquidity(self) -> str:
        amount = int(gl.message.value)
        if amount == 0:
            _fail(ERR_PARAM, "send value to supply")
        total_assets = int(self.pool_cash) + int(self.total_borrows)
        shares_total = int(self.total_shares)
        if shares_total == 0:
            minted = amount
        else:
            if total_assets == 0:
                _fail(ERR_STATE, "pool has shares but no assets")
            minted = (amount * shares_total) // total_assets
        if minted == 0:
            _fail(ERR_PARAM, "deposit too small to mint a share")
        key = gl.message.sender_address.as_hex.lower()
        self.lp_shares[key] = self._get(self.lp_shares, key) + minted
        self.total_shares = shares_total + minted
        self.pool_cash = int(self.pool_cash) + amount
        return str(minted)

    @gl.public.write
    def withdraw_liquidity(self, shares: u256) -> str:
        sh = int(shares)
        key = gl.message.sender_address.as_hex.lower()
        have = self._get(self.lp_shares, key)
        if sh == 0 or sh > have:
            _fail(ERR_PARAM, "invalid share amount")
        assets = self._shares_value(sh)
        if assets == 0:
            _fail(ERR_PARAM, "shares are worth nothing")
        if assets > int(self.pool_cash):
            _fail(ERR_LIQUIDITY, "not enough idle cash; repay or wait")
        self.lp_shares[key] = have - sh
        self.total_shares = int(self.total_shares) - sh
        self.pool_cash = int(self.pool_cash) - assets
        gl.chain.Account(gl.message.sender_address).emit_transfer(assets, on="finalized")
        return str(assets)

    @gl.public.write.payable
    def deposit_collateral(self) -> str:
        amount = int(gl.message.value)
        if amount == 0:
            _fail(ERR_PARAM, "send value to deposit")
        key = gl.message.sender_address.as_hex.lower()
        self._sync_borrower(key)
        self.collateral[key] = self._get(self.collateral, key) + amount
        self.total_collateral = int(self.total_collateral) + amount
        return str(self.collateral[key])

    @gl.public.write
    def borrow(self, amount: u256) -> str:
        amt = int(amount)
        if amt == 0:
            _fail(ERR_PARAM, "amount must be positive")
        key = gl.message.sender_address.as_hex.lower()
        self._sync_borrower(key)
        if amt > int(self.pool_cash):
            _fail(ERR_LIQUIDITY, "not enough idle cash")
        new_debt = self._get(self.debt, key) + amt
        max_ltv = RISK_TIERS[int(self.risk_level)][0]
        # exact integer test: new_debt / collateral <= max_ltv / 10000
        if new_debt * BPS > self._get(self.collateral, key) * max_ltv:
            _fail(ERR_LTV, f"borrow would exceed the active {max_ltv} bps max LTV")
        self.debt[key] = new_debt
        self.principal[key] = self._get(self.principal, key) + amt
        self.total_borrows = int(self.total_borrows) + amt
        self.pool_cash = int(self.pool_cash) - amt
        gl.chain.Account(gl.message.sender_address).emit_transfer(amt, on="finalized")
        return str(new_debt)

    @gl.public.write.payable
    def repay(self) -> dict:
        sent = int(gl.message.value)
        if sent == 0:
            _fail(ERR_PARAM, "send value to repay")
        key = gl.message.sender_address.as_hex.lower()
        self._sync_borrower(key)
        owed = self._get(self.debt, key)
        if owed == 0:
            _fail(ERR_NO_DEBT, "no outstanding debt")
        pay = sent if sent < owed else owed
        princ = self._get(self.principal, key)
        interest_owed = owed - princ
        interest_part = pay if pay < interest_owed else interest_owed
        principal_part = pay - interest_part
        rf = RISK_TIERS[int(self.risk_level)][2]
        reserve_cut = (interest_part * rf) // BPS
        self.debt[key] = owed - pay
        self.principal[key] = princ - principal_part
        self.total_borrows = int(self.total_borrows) - pay
        self.reserve_pool = int(self.reserve_pool) + reserve_cut
        self.pool_cash = int(self.pool_cash) + (pay - reserve_cut)
        excess = sent - pay
        if excess > 0:
            self._credit(key, excess)
        return {
            "paid_wei": str(pay),
            "interest_paid_wei": str(interest_part),
            "principal_paid_wei": str(principal_part),
            "reserve_cut_wei": str(reserve_cut),
            "remaining_debt_wei": str(owed - pay),
            "refund_claimable_wei": str(excess),
        }

    @gl.public.write
    def withdraw(self, amount: u256) -> str:
        amt = int(amount)
        key = gl.message.sender_address.as_hex.lower()
        self._sync_borrower(key)
        coll = self._get(self.collateral, key)
        if amt == 0 or amt > coll:
            _fail(ERR_PARAM, "invalid collateral amount")
        remaining = coll - amt
        max_ltv = RISK_TIERS[int(self.risk_level)][0]
        if self._get(self.debt, key) * BPS > remaining * max_ltv:
            _fail(ERR_LTV, f"withdrawal would breach the active {max_ltv} bps max LTV")
        self.collateral[key] = remaining
        self.total_collateral = int(self.total_collateral) - amt
        gl.chain.Account(gl.message.sender_address).emit_transfer(amt, on="finalized")
        return str(remaining)

    # --------------------------------------------------------------- internals
    def _now(self) -> int:
        # Inside GenVM datetime.now() is patched to the transaction timestamp.
        return int(datetime.now(timezone.utc).timestamp())

    def _only_governor(self) -> None:
        if gl.message.sender_address != self.governor:
            _fail(ERR_UNAUTHORIZED, "governor only")

    def _get(self, m, key) -> int:
        if key in m:
            return int(m[key])
        return 0

    def _bump(self, m, key) -> None:
        m[key] = self._get(m, key) + 1

    def _credit(self, key: str, amount: int) -> None:
        self.claimable[key] = self._get(self.claimable, key) + amount
        self.total_claimable = int(self.total_claimable) + amount

    def _tracked(self) -> int:
        return (
            int(self.pool_cash)
            + int(self.total_collateral)
            + int(self.reserve_pool)
            + int(self.insurance_reserve)
            + int(self.total_claimable)
        )

    def _check_unique_operators(self, slot: int, op: str) -> None:
        for other in range(SLOT_COUNT):
            if other != slot and self.feed_operator[other] == op:
                _fail(ERR_FEED, "operator already runs another feed")

    def _shares_value(self, shares: int) -> int:
        total = int(self.total_shares)
        if total == 0:
            return 0
        return (shares * (int(self.pool_cash) + int(self.total_borrows))) // total

    def _index_at(self, now: int) -> int:
        idx = int(self.borrow_index)
        dt = now - int(self.index_updated_at)
        if dt <= 0:
            return idx
        rate = RISK_TIERS[int(self.risk_level)][1]
        return idx + (idx * rate * dt) // (BPS * SECONDS_PER_YEAR)

    def _accrue_global(self, now: int) -> None:
        self.borrow_index = self._index_at(now)
        if now > int(self.index_updated_at):
            self.index_updated_at = now

    def _debt_at(self, key: str, index: int) -> int:
        d = self._get(self.debt, key)
        if d == 0:
            return 0
        snap = self._get(self.debt_index, key)
        if snap == 0 or snap == index:
            return d
        # round UP so the protocol never under-collects
        return (d * index + snap - 1) // snap

    def _sync_borrower(self, key: str) -> None:
        """Bring the global index current, then realise this borrower's
        interest into both their debt and total_borrows, keeping the two equal
        to the wei."""
        self._accrue_global(self._now())
        index = int(self.borrow_index)
        old = self._get(self.debt, key)
        new = self._debt_at(key, index)
        if new != old:
            self.debt[key] = new
            self.total_borrows = int(self.total_borrows) + (new - old)
        self.debt_index[key] = index
