"""AegisMacro direct-mode suite: constructor, feed registry, the 5-step
aggregate, the Watchtower desk, the consensus validator, governance and the
lending sandbox. Every test drives the real contract through the GenVM harness.
"""

import ast
import hashlib
import itertools
import json

import pytest
from conftest import (
    ATTO,
    BASE_A,
    BASE_B,
    BASE_C,
    BASES,
    BOND,
    CONTRACT,
    CRITICAL,
    DAY,
    ELEVATED,
    FEEDS_DIR,
    NORMAL,
    QUORUM_FAILURE,
    REJECTED,
    SHA,
    SHA2,
    T0_TS,
    TIERS,
    VERIFIED,
    YEAR,
    World,
    feed_doc,
    hex_of,
)
from gltest.direct.loader import create_address

# ===========================================================================
# 1. Deployment and constructor guards
# ===========================================================================


def test_deploy_sets_governor_and_bond(world):
    s = world.state()
    assert s["governor"].lower() == hex_of(world.gov)
    assert s["watchtower_bond_wei"] == str(BOND)


def test_initial_tier_is_normal(world):
    st = world.view("get_risk_status")
    assert st["risk_level"] == NORMAL
    assert st["risk_name"] == "RISK_LEVEL_NORMAL"
    assert st["max_ltv_bps"] == 8000
    assert st["base_borrow_rate_bps"] == 400
    assert st["reserve_factor_bps"] == 1000
    assert st["last_applied_epoch"] == 0
    assert st["shift_count"] == 0


def test_initial_buckets_are_zero(world):
    s = world.state()
    for key in (
        "insurance_reserve_wei",
        "reserve_pool_wei",
        "pool_cash_wei",
        "total_collateral_wei",
        "total_borrows_wei",
        "total_shares",
        "total_claimable_wei",
        "contract_balance_wei",
        "tracked_wei",
    ):
        assert s[key] == "0", key
    assert s["solvent"] is True
    assert s["borrow_index"] == str(ATTO)


def test_feed_registry_initial_layout(world):
    feeds = world.view("get_feed_sources")
    assert [f["slot"] for f in feeds] == [0, 1, 2]
    assert [f["host"] for f in feeds] == ["raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com"]
    assert [f["base_url"] for f in feeds] == list(BASES)
    assert [f["label"] for f in feeds] == [
        "SEC_REGULATORY_MIRROR",
        "CENTRAL_BANK_MACRO_MIRROR",
        "GLOBAL_ECONOMIC_WIRE_MIRROR",
    ]
    assert all(f["rotation_eta"] == 0 and f["pending_base_url"] == "" for f in feeds)


def test_feed_operators_are_the_constructor_operators(world):
    ops = [f["operator"] for f in world.view("get_feed_sources")]
    assert ops == [hex_of(o) for o in world.ops]


def test_tier_table_matches_spec(world):
    table = world.view("get_risk_tiers")
    assert len(table) == 3
    for row in table:
        want = TIERS[row["risk_level"]]
        for k, v in want.items():
            assert row[k] == v


@pytest.mark.parametrize("bond", [0, 1, BOND - 1, 10**17])
def test_bond_below_floor_rejected(direct_vm, direct_deploy, bond):
    w = World(direct_vm, direct_deploy)
    with direct_vm.expect_revert("ERR_INSUFFICIENT_BOND"):
        w.deployed(bond=bond)


@pytest.mark.parametrize("bond", [BOND, BOND + 1, ATTO, 5 * ATTO])
def test_bond_at_or_above_floor_accepted(direct_vm, direct_deploy, bond):
    w = World(direct_vm, direct_deploy)
    w.deployed(bond=bond)
    assert w.state()["watchtower_bond_wei"] == str(bond)


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_constructor_rejects_wrong_host_for_slot(direct_vm, direct_deploy, slot):
    w = World(direct_vm, direct_deploy)
    bases = list(BASES)
    bases[slot] = BASES[(slot + 1) % 3]
    with direct_vm.expect_revert("ERR_INVALID_FEED_SOURCE"):
        w.deployed(bases=bases)


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_constructor_rejects_branch_ref_instead_of_commit(direct_vm, direct_deploy, slot):
    w = World(direct_vm, direct_deploy)
    bases = list(BASES)
    bases[slot] = BASES[slot].replace(SHA, "main")
    with direct_vm.expect_revert("40-hex"):
        w.deployed(bases=bases)


def test_constructor_rejects_duplicate_operators(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    same = hex_of(w.ops[0])
    with direct_vm.expect_revert("ERR_INVALID_FEED_SOURCE"):
        w.deployed(ops=[same, same, hex_of(w.ops[2])])


def test_constructor_rejects_governor_as_operator(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    with direct_vm.expect_revert("governor cannot operate a feed"):
        w.deployed(ops=[hex_of(w.gov), hex_of(w.ops[1]), hex_of(w.ops[2])])


@pytest.mark.parametrize("bad", ["", "0x1234", "not-an-address", "0x" + "zz" * 20, "11" * 20, "0x" + "11" * 21])
def test_constructor_rejects_malformed_operator(direct_vm, direct_deploy, bad):
    w = World(direct_vm, direct_deploy)
    with direct_vm.expect_revert("ERR_INVALID_PARAM"):
        w.deployed(ops=[bad, hex_of(w.ops[1]), hex_of(w.ops[2])])


def test_operator_hex_is_case_normalised(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    ops = ["0x" + "AB" * 20, hex_of(w.ops[1]), hex_of(w.ops[2])]
    w.deployed(ops=ops)
    assert w.view("get_feed_sources")[0]["operator"] == "0x" + "ab" * 20


def test_case_variant_duplicate_operator_still_rejected(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    a = "0x" + "ab" * 20
    with direct_vm.expect_revert("ERR_INVALID_FEED_SOURCE"):
        w.deployed(ops=[a, a.upper().replace("0X", "0x"), hex_of(w.ops[2])])


# ===========================================================================
# 2. Feed URL validation (registry hardening)
# ===========================================================================

GOOD = {0: BASE_A, 1: BASE_B, 2: BASE_C}


def url_problem(world, slot, url):
    return world.view("is_valid_feed_url", slot, url)


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_good_urls_accepted(world, slot):
    assert url_problem(world, slot, GOOD[slot]) == ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_other_commit_sha_accepted(world, slot):
    assert url_problem(world, slot, GOOD[slot].replace(SHA, SHA2)) == ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_http_scheme_rejected(world, slot):
    assert "https required" in url_problem(world, slot, GOOD[slot].replace("https://", "http://"))


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_userinfo_rejected(world, slot):
    host = ("raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com")[slot]
    evil = GOOD[slot].replace(host, f"user:pw@{host}")
    assert url_problem(world, slot, evil) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_port_rejected(world, slot):
    host = ("raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com")[slot]
    assert url_problem(world, slot, GOOD[slot].replace(host, host + ":8443")) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_query_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot] + "?x=1") != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_fragment_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot] + "#frag") != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_traversal_rejected(world, slot):
    assert "traversal" in url_problem(world, slot, GOOD[slot] + "../")


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_double_slash_rejected(world, slot):
    assert "traversal" in url_problem(world, slot, GOOD[slot] + "/x/")


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_percent_encoding_rejected(world, slot):
    assert "illegal character" in url_problem(world, slot, GOOD[slot] + "%2e%2e/")


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_must_be_directory(world, slot):
    assert url_problem(world, slot, GOOD[slot] + "epoch_1.json") != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_foreign_repo_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot].replace("moltaphet/AegisMacro", "attacker/Evil")) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_short_sha_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot].replace(SHA, SHA[:39])) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_uppercase_sha_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot].replace(SHA, SHA.upper().replace("0X", "0x"))) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_empty_and_whitespace_rejected(world, slot):
    assert url_problem(world, slot, "") != ""
    assert url_problem(world, slot, " " + GOOD[slot]) != ""
    assert url_problem(world, slot, GOOD[slot] + " ") != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_non_ascii_rejected(world, slot):
    assert url_problem(world, slot, GOOD[slot].replace("mock_feeds", "mock_féeds")) != ""


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_overlong_url_rejected(world, slot):
    assert "too long" in url_problem(world, slot, GOOD[slot] + "a" * 400 + "/")


@pytest.mark.parametrize("slot", [0, 1, 2])
def test_cross_slot_url_rejected(world, slot):
    for other in range(3):
        if other != slot:
            assert url_problem(world, slot, GOOD[other]) != ""


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "169.254.169.254", "evil.example"])
def test_arbitrary_hosts_rejected(world, host):
    assert url_problem(world, 0, f"https://{host}/moltaphet/AegisMacro/{SHA}/x/") != ""


def test_slot_out_of_range_reports_reason(world):
    assert "slot" in url_problem(world, 3, BASE_A)


# ===========================================================================
# 3. The 5-step aggregate, exhaustively (preview_aggregate is pure)
# ===========================================================================

KINDS = ("claim", "other", "alt", "nf", "bad")


def obs_of(kind: str, claim: int) -> dict:
    other = (claim + 1) % 3
    if kind == "claim":
        return {"status": "OK", "risk_level": claim, "event_id": "E"}
    if kind == "other":
        return {"status": "OK", "risk_level": other, "event_id": "E"}
    if kind == "alt":
        return {"status": "OK", "risk_level": claim, "event_id": "F"}
    if kind == "nf":
        return {"status": "NOT_FOUND"}
    return {"status": "UNUSABLE"}


def oracle(kinds, claim):
    """Independent restatement of the spec: slash only on a 2-source
    contradiction or a 2-source 404; verify on a 2-source match."""
    other = (claim + 1) % 3
    keys = {"claim": (claim, "E"), "other": (other, "E"), "alt": (claim, "F")}
    tally = {}
    for k in kinds:
        if k in keys:
            tally[keys[k]] = tally.get(keys[k], 0) + 1
    nf = kinds.count("nf")
    for key, n in tally.items():
        if n >= 2:
            return (VERIFIED if key[0] == claim else REJECTED), key[0]
    if nf >= 2:
        return REJECTED, -1
    return QUORUM_FAILURE, -1


@pytest.mark.parametrize("kinds", list(itertools.product(KINDS, repeat=3)), ids=lambda k: "-".join(k))
@pytest.mark.parametrize("claim", [ELEVATED])
def test_aggregate_matches_spec_oracle(world, kinds, claim):
    obs = [obs_of(k, claim) for k in kinds]
    out = world.view("preview_aggregate", json.dumps(obs), claim, 5)
    verdict, level = oracle(list(kinds), claim)
    assert (out["verdict"], out["risk_level"]) == (verdict, level)


@pytest.mark.parametrize("claim", [NORMAL, ELEVATED, CRITICAL])
def test_aggregate_claim_independent_for_all_tiers(world, claim):
    for kinds in [("claim", "claim", "bad"), ("other", "other", "nf"), ("nf", "nf", "claim"), ("claim", "nf", "bad")]:
        obs = [obs_of(k, claim) for k in kinds]
        out = world.view("preview_aggregate", json.dumps(obs), claim, 3)
        verdict, level = oracle(list(kinds), claim)
        assert (out["verdict"], out["risk_level"]) == (verdict, level)


def agg(world, specs, claim=ELEVATED, epoch=1):
    return world.view("preview_aggregate", json.dumps(specs), claim, epoch)


OK1 = {"status": "OK", "risk_level": 1, "event_id": "X"}
NF = {"status": "NOT_FOUND"}
DOWN = {"status": "UNUSABLE"}


def test_spec_one_confirmed_one_404_one_outage_is_retryable(world):
    out = agg(world, [OK1, NF, DOWN])
    assert out["verdict"] == QUORUM_FAILURE
    assert out["risk_level"] == -1
    assert out["announcement_hash"] == ""


def test_spec_outage_position_does_not_matter(world):
    for perm in itertools.permutations([OK1, NF, DOWN]):
        assert agg(world, list(perm))["verdict"] == QUORUM_FAILURE


def test_spec_fewer_than_two_responses_is_retryable(world):
    assert agg(world, [OK1, DOWN, DOWN])["verdict"] == QUORUM_FAILURE
    assert agg(world, [NF, DOWN, DOWN])["verdict"] == QUORUM_FAILURE
    assert agg(world, [DOWN, DOWN, DOWN])["verdict"] == QUORUM_FAILURE


def test_spec_two_matching_sources_verify(world):
    out = agg(world, [OK1, OK1, DOWN])
    assert out["verdict"] == VERIFIED and out["risk_level"] == 1 and out["source_count"] == 2


def test_spec_three_matching_sources_verify(world):
    out = agg(world, [OK1, OK1, OK1])
    assert out["verdict"] == VERIFIED and out["source_count"] == 3


def test_spec_two_404_is_rejected_as_fabricated(world):
    out = agg(world, [NF, NF, DOWN])
    assert out["verdict"] == REJECTED and out["risk_level"] == -1


def test_spec_three_404_is_rejected(world):
    assert agg(world, [NF, NF, NF])["verdict"] == REJECTED


def test_spec_two_normal_sources_contradict_emergency_claim(world):
    normal = {"status": "OK", "risk_level": 0, "event_id": "X"}
    out = agg(world, [normal, normal, DOWN], claim=CRITICAL)
    assert out["verdict"] == REJECTED and out["risk_level"] == 0


def test_lone_dissenter_cannot_outvote_quorum(world):
    other = {"status": "OK", "risk_level": 2, "event_id": "X"}
    assert agg(world, [OK1, OK1, other])["verdict"] == VERIFIED


def test_three_way_split_is_retryable_not_slashed(world):
    split = [
        {"status": "OK", "risk_level": 0, "event_id": "X"},
        {"status": "OK", "risk_level": 1, "event_id": "X"},
        {"status": "OK", "risk_level": 2, "event_id": "X"},
    ]
    for claim in (0, 1, 2):
        assert agg(world, split, claim=claim)["verdict"] == QUORUM_FAILURE


def test_same_tier_different_event_is_not_a_quorum(world):
    a = {"status": "OK", "risk_level": 1, "event_id": "A"}
    b = {"status": "OK", "risk_level": 1, "event_id": "B"}
    assert agg(world, [a, b, DOWN])["verdict"] == QUORUM_FAILURE


def test_announcement_hash_binds_epoch_level_event(world):
    out = agg(world, [OK1, OK1, DOWN], epoch=7)
    assert out["announcement_hash"] == hashlib.sha256(b"7|1|X").hexdigest()


def test_announcement_hash_is_independent_of_which_pair_agrees(world):
    h = {agg(world, list(p))["announcement_hash"] for p in [(OK1, OK1, DOWN), (OK1, DOWN, OK1), (DOWN, OK1, OK1), (OK1, OK1, OK1)]}
    assert len(h) == 1


def test_announcement_hash_changes_with_epoch(world):
    assert agg(world, [OK1, OK1, DOWN], epoch=1)["announcement_hash"] != agg(world, [OK1, OK1, DOWN], epoch=2)["announcement_hash"]


def test_fabrication_hash_is_deterministic(world):
    out = agg(world, [NF, NF, NF], epoch=4)
    assert out["announcement_hash"] == hashlib.sha256(b"4|NOT_FOUND").hexdigest()


def test_payload_has_exactly_four_integer_and_string_fields(world):
    out = agg(world, [OK1, OK1, OK1])
    assert set(out) == {"verdict", "risk_level", "source_count", "announcement_hash"}
    assert isinstance(out["verdict"], int) and isinstance(out["risk_level"], int)
    assert isinstance(out["source_count"], int) and isinstance(out["announcement_hash"], str)


@pytest.mark.parametrize(
    "junk",
    [
        {"status": "OK", "risk_level": 3, "event_id": "X"},
        {"status": "OK", "risk_level": -1, "event_id": "X"},
        {"status": "OK", "risk_level": True, "event_id": "X"},
        {"status": "OK", "risk_level": "1", "event_id": "X"},
        {"status": "OK", "risk_level": 1, "event_id": ""},
        {"status": "OK", "risk_level": 1, "event_id": "bad id!"},
        {"status": "OK", "risk_level": 1, "event_id": "x" * 65},
        {"status": "OK", "risk_level": 1},
        {"status": "PENDING"},
        {},
        "string",
        None,
        7,
    ],
)
def test_malformed_observations_count_as_unusable(world, junk):
    out = agg(world, [OK1, junk, DOWN])
    assert out["verdict"] == QUORUM_FAILURE


def test_malformed_observations_cannot_form_a_quorum(world):
    junk = {"status": "OK", "risk_level": 9, "event_id": "X"}
    assert agg(world, [junk, junk, junk])["verdict"] == QUORUM_FAILURE


def test_preview_requires_exactly_three(world):
    for n in (0, 1, 2, 4):
        with world.vm.expect_revert("exactly 3"):
            agg(world, [OK1] * n)


def test_preview_rejects_non_json(world):
    with world.vm.expect_revert("not JSON"):
        world.view("preview_aggregate", "{nope", 1, 1)


def test_preview_rejects_out_of_range_claim(world):
    with world.vm.expect_revert("claimed_level"):
        agg(world, [OK1, OK1, OK1], claim=3)


# ===========================================================================
# 4. Watchtower desk: report_risk end to end through mocked mirrors
# ===========================================================================


def claim_balance(world, who):
    return int(world.view("claimable_of", hex_of(who)))


def test_verified_report_applies_tier_and_returns_bond(world):
    world.feeds.all_agree(1, ELEVATED)
    out = world.report(1, ELEVATED)
    assert out["verdict"] == VERIFIED and out["verdict_name"] == "VERIFIED_RISK_SHIFT"
    assert out["applied_level"] == ELEVATED and out["level_changed"] is True
    assert out["bond_intact"] is True and out["slashed_wei"] == "0"
    st = world.view("get_risk_status")
    assert st["risk_level"] == ELEVATED and st["last_applied_epoch"] == 1 and st["shift_count"] == 1
    assert st["max_ltv_bps"] == 7000 and st["base_borrow_rate_bps"] == 750 and st["reserve_factor_bps"] == 2000
    assert claim_balance(world, world.watch) == BOND
    world.assert_conserved()


@pytest.mark.parametrize("level", [NORMAL, ELEVATED, CRITICAL])
def test_every_tier_binds_its_bps_parameters(world, level):
    # step through a non-normal tier first so NORMAL is a real shift too
    if level == NORMAL:
        world.set_tier(CRITICAL)
    world.set_tier(level)
    st = world.view("get_risk_status")
    for k, v in TIERS[level].items():
        assert st[k] == v


def test_report_is_recorded(world):
    world.feeds.all_agree(1, ELEVATED, "EVT-9")
    out = world.report(1, ELEVATED)
    rep = world.view("get_report", out["report_id"])
    assert rep["watchtower"] == hex_of(world.watch)
    assert (rep["epoch"], rep["claimed_level"], rep["verdict"]) == (1, ELEVATED, VERIFIED)
    assert rep["quorum_present"] is True and rep["quorum_level"] == ELEVATED
    assert rep["announcement_hash"] == hashlib.sha256(b"1|1|EVT-9").hexdigest()
    assert rep["bond_wei"] == str(BOND) and rep["source_count"] == 3
    assert world.view("get_report_count") == 1


def test_unknown_report_reverts(world):
    with world.vm.expect_revert("unknown report"):
        world.view("get_report", 1)


def test_bond_below_minimum_reverts(world):
    world.feeds.all_agree(1, ELEVATED)
    world.revert_msg(world.watch, "report_risk", 1, ELEVATED, value=BOND - 1, message="ERR_INSUFFICIENT_BOND")


def test_zero_bond_reverts(world):
    world.feeds.all_agree(1, ELEVATED)
    world.revert_msg(world.watch, "report_risk", 1, ELEVATED, value=0, message="ERR_INSUFFICIENT_BOND")


def test_configured_bond_is_enforced(direct_vm, direct_deploy):
    w = World(direct_vm, direct_deploy)
    w.deployed(bond=ATTO)
    w.feeds.all_agree(1, ELEVATED)
    w.revert_msg(w.watch, "report_risk", 1, ELEVATED, value=ATTO - 1, message="ERR_INSUFFICIENT_BOND")
    assert w.report(1, ELEVATED, value=ATTO)["verdict"] == VERIFIED


def test_overbond_is_fully_returned_on_success(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED, value=3 * BOND)
    assert claim_balance(world, world.watch) == 3 * BOND
    world.assert_conserved()


def test_overbond_is_fully_slashed_on_rejection(world):
    world.feeds.serve(1, "404", "404", "404")
    out = world.report(1, ELEVATED, value=3 * BOND)
    assert out["verdict"] == REJECTED and out["slashed_wei"] == str(3 * BOND)
    assert world.state()["insurance_reserve_wei"] == str(3 * BOND)


def test_claimed_level_out_of_range_reverts(world):
    world.feeds.all_agree(1, ELEVATED)
    world.revert_msg(world.watch, "report_risk", 1, 3, value=BOND, message="claimed_level")


@pytest.mark.parametrize("epoch", [0, 17, 18, 1000, 10**9])
def test_epoch_outside_window_reverts(world, epoch):
    world.revert_msg(world.watch, "report_risk", epoch, ELEVATED, value=BOND, message="ERR_EPOCH_OUT_OF_RANGE")


@pytest.mark.parametrize("epoch", [1, 2, 8, 16])
def test_epoch_inside_window_accepted(world, epoch):
    world.feeds.all_agree(epoch, ELEVATED)
    assert world.report(epoch, ELEVATED)["verdict"] == VERIFIED


def test_window_slides_with_applied_epoch(world):
    world.set_tier(ELEVATED, epoch=5)
    world.revert_msg(world.watch, "report_risk", 22, CRITICAL, value=BOND, message="ERR_EPOCH_OUT_OF_RANGE")
    world.feeds.all_agree(21, CRITICAL)
    assert world.report(21, CRITICAL)["verdict"] == VERIFIED


def test_applied_epoch_cannot_be_replayed(world):
    world.set_tier(ELEVATED, epoch=3)
    world.revert_msg(world.watch, "report_risk", 3, ELEVATED, value=BOND, message="ERR_EPOCH_OUT_OF_RANGE")


def test_older_epoch_cannot_roll_the_tier_back(world):
    world.set_tier(CRITICAL, epoch=4)
    world.feeds.all_agree(2, NORMAL)
    world.revert_msg(world.watch, "report_risk", 2, NORMAL, value=BOND, message="ERR_EPOCH_OUT_OF_RANGE")
    assert world.view("get_risk_status")["risk_level"] == CRITICAL


@pytest.mark.parametrize("third", ["404", "410", "500", "503", "429", "403", "down", "garbage", "empty"])
def test_two_of_three_verifies_whatever_the_third_does(world, third):
    world.feeds.serve(1, ("ok", ELEVATED), ("ok", ELEVATED), third)
    out = world.report(1, ELEVATED)
    assert out["verdict"] == VERIFIED
    # a 404/410 is a definitive answer (counted); outages and bad bodies are not
    assert out["source_count"] == (3 if third in ("404", "410") else 2)
    assert out["bond_intact"] is True


@pytest.mark.parametrize("perm", list(itertools.permutations([("ok", CRITICAL), ("ok", CRITICAL), "500"])))
def test_slot_order_is_irrelevant(world, perm):
    world.feeds.serve(1, *perm)
    assert world.report(1, CRITICAL)["verdict"] == VERIFIED


def test_fabricated_event_slashes_into_insurance(world):
    world.feeds.serve(1, "404", "404", "404")
    out = world.report(1, CRITICAL)
    assert out["verdict"] == REJECTED and out["verdict_name"] == "REJECTED_REPORT"
    assert out["slashed_wei"] == str(BOND) and out["bond_intact"] is False
    s = world.state()
    assert s["insurance_reserve_wei"] == str(BOND)
    assert claim_balance(world, world.watch) == 0
    assert world.view("get_risk_status")["risk_level"] == NORMAL
    world.assert_conserved()


def test_two_404s_with_an_outage_still_slash(world):
    world.feeds.serve(1, "404", "404", "down")
    assert world.report(1, CRITICAL)["verdict"] == REJECTED


def test_contradicted_emergency_report_is_slashed(world):
    world.feeds.serve(1, ("ok", NORMAL), ("ok", NORMAL), ("ok", CRITICAL))
    out = world.report(1, CRITICAL)
    assert out["verdict"] == REJECTED and out["risk_level"] == NORMAL
    assert world.state()["insurance_reserve_wei"] == str(BOND)


def test_understating_a_crisis_is_also_contradicted(world):
    world.feeds.all_agree(1, CRITICAL)
    assert world.report(1, ELEVATED)["verdict"] == REJECTED


def test_rejection_does_not_consume_the_epoch(world):
    world.feeds.serve(1, ("ok", NORMAL), ("ok", NORMAL), "down")
    assert world.report(1, CRITICAL)["verdict"] == REJECTED
    assert world.view("get_risk_status")["last_applied_epoch"] == 0
    world.vm.clear_mocks()
    world.feeds.all_agree(1, NORMAL)
    assert world.report(1, NORMAL, sender=world.watch2)["verdict"] == VERIFIED


@pytest.mark.parametrize(
    "specs",
    [
        (("ok", 1), "404", "down"),
        (("ok", 1), "down", "down"),
        ("404", "down", "down"),
        ("down", "down", "down"),
        (("ok", 1), "500", "503"),
        (("ok", 0), ("ok", 1), ("ok", 2)),
        (("ok", 1, "A"), ("ok", 1, "B"), "down"),
        (("ok", 1), "garbage", "empty"),
        ("429", "403", "500"),
    ],
)
def test_inconclusive_outcomes_never_slash(world, specs):
    world.feeds.serve(1, *specs)
    out = world.report(1, ELEVATED)
    assert out["verdict"] == QUORUM_FAILURE and out["verdict_name"] == "QUORUM_FAILURE"
    assert out["bond_intact"] is True and out["slashed_wei"] == "0"
    assert claim_balance(world, world.watch) == BOND
    assert world.state()["insurance_reserve_wei"] == "0"
    assert world.view("get_risk_status")["last_applied_epoch"] == 0
    world.assert_conserved()


def test_network_outage_total_blackout_keeps_bond(world):
    out = world.report(1, CRITICAL)  # nothing mocked: every fetch raises
    assert out["verdict"] == QUORUM_FAILURE and out["source_count"] == 0
    assert claim_balance(world, world.watch) == BOND


def test_quorum_failure_is_retryable_for_the_same_epoch(world):
    world.feeds.serve(1, ("ok", ELEVATED), "404", "down")
    assert world.report(1, ELEVATED)["verdict"] == QUORUM_FAILURE
    world.vm.clear_mocks()
    world.feeds.all_agree(1, ELEVATED)
    assert world.report(1, ELEVATED)["verdict"] == VERIFIED
    assert claim_balance(world, world.watch) == 2 * BOND


def test_stale_lag_then_catch_up(world):
    world.feeds.serve(1, ("ok", CRITICAL), "404", "404")
    assert world.report(1, CRITICAL)["verdict"] == REJECTED  # two 404s = nothing published yet
    world.vm.clear_mocks()
    world.feeds.all_agree(1, CRITICAL)
    assert world.report(1, CRITICAL, sender=world.watch2)["verdict"] == VERIFIED


def test_record_epoch_mismatch_is_unusable(world):
    world.feeds.serve(1, ("doc", {"epoch": 2}), ("doc", {"epoch": 2}), ("ok", 1))
    assert world.report(1, ELEVATED)["verdict"] == QUORUM_FAILURE


@pytest.mark.parametrize(
    "bad",
    [
        {"schema": "other.v9"},
        {"schema": None},
        {"risk_level": 7},
        {"risk_level": "1"},
        {"risk_level": True},
        {"risk_level": None},
        {"epoch": "1"},
        {"epoch": True},
        {"epoch": None},
        {"event_id": ""},
        {"event_id": "has space"},
        {"event_id": "x" * 65},
        {"event_id": None},
        {"event_id": 5},
    ],
)
def test_malformed_records_are_unusable(world, bad):
    world.feeds.serve(1, ("doc", bad), ("doc", bad), ("ok", 1))
    # two unusable + one good record: no quorum, nobody slashed
    out = world.report(1, ELEVATED)
    assert out["verdict"] == QUORUM_FAILURE and out["bond_intact"] is True


def test_oversized_body_is_unusable(world):
    big = json.loads(feed_doc(1, 1))
    big["pad"] = "x" * 9000
    world.feeds.serve(1, ("raw", 200, json.dumps(big)), ("raw", 200, json.dumps(big)), ("ok", 1))
    assert world.report(1, ELEVATED)["verdict"] == QUORUM_FAILURE


def test_non_object_json_is_unusable(world):
    world.feeds.serve(1, ("raw", 200, "[1,2,3]"), ("raw", 200, "42"), ("raw", 200, "null"))
    assert world.report(1, ELEVATED)["verdict"] == QUORUM_FAILURE


def test_extra_fields_in_a_record_are_tolerated(world):
    world.feeds.serve(1, ("doc", {"headline": "x", "extra": [1, 2]}), ("doc", {"extra": {}}), ("ok", 1))
    assert world.report(1, ELEVATED)["verdict"] == VERIFIED


def test_redirect_status_is_unusable_not_a_404(world):
    world.feeds.serve(1, ("raw", 301, ""), ("raw", 302, ""), ("raw", 308, ""))
    out = world.report(1, ELEVATED)
    assert out["verdict"] == QUORUM_FAILURE


def test_only_mirrors_in_the_registry_are_read(world):
    # a perfect quorum served from an unregistered host must be invisible
    world.vm.mock_web(r"evil\.example/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, ELEVATED)})
    assert world.report(1, ELEVATED)["verdict"] == QUORUM_FAILURE


def test_each_slot_reads_only_its_own_host(world):
    # every record is served from slot A's host only: B and C see nothing, so
    # one definitive-looking source can never make a quorum by itself
    world.vm.mock_web(r"raw\.githubusercontent\.com/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, ELEVATED)})
    out = world.report(1, ELEVATED)
    assert out["verdict"] == QUORUM_FAILURE and out["source_count"] == 1


def test_claim_payout_moves_exactly_the_credit(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED)
    paid = world.tx(world.watch, "claim_payout")
    assert paid == str(BOND)
    assert claim_balance(world, world.watch) == 0
    assert world.state()["total_claimable_wei"] == "0"
    world.assert_conserved()


def test_claim_payout_twice_reverts(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED)
    world.tx(world.watch, "claim_payout")
    world.revert_msg(world.watch, "claim_payout", message="ERR_NO_CLAIMABLE_BALANCE")


def test_claim_payout_without_credit_reverts(world):
    world.revert_msg(world.alice, "claim_payout", message="ERR_NO_CLAIMABLE_BALANCE")


def test_claim_cannot_touch_someone_elses_credit(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED)
    world.revert_msg(world.watch2, "claim_payout", message="ERR_NO_CLAIMABLE_BALANCE")
    assert claim_balance(world, world.watch) == BOND


def test_watchtower_counters(world):
    world.feeds.serve(1, "404", "404", "404")
    world.report(1, CRITICAL)
    world.vm.clear_mocks()
    world.feeds.serve(1, ("ok", 1), "down", "down")
    world.report(1, ELEVATED)
    world.vm.clear_mocks()
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED)
    w = world.view("get_watchtower", hex_of(world.watch))
    assert (w["verified"], w["rejected"], w["inconclusive"]) == (1, 1, 1)
    s = world.state()
    assert (s["verified_reports"], s["rejected_reports"], s["inconclusive_reports"], s["report_count"]) == (1, 1, 1, 3)


def test_unchanged_tier_confirmation_advances_epoch_without_shift(world):
    world.feeds.all_agree(1, NORMAL)
    out = world.report(1, NORMAL)
    assert out["verdict"] == VERIFIED and out["level_changed"] is False
    st = world.view("get_risk_status")
    assert st["last_applied_epoch"] == 1 and st["shift_count"] == 0


def test_shift_count_tracks_real_changes_only(world):
    world.set_tier(ELEVATED)  # 0 -> 1
    world.set_tier(ELEVATED)  # 1 -> 1
    world.set_tier(CRITICAL)  # 1 -> 2
    world.set_tier(NORMAL)  # 2 -> 0
    assert world.view("get_risk_status")["shift_count"] == 3


def test_two_watchtowers_race_first_verified_wins(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED, sender=world.watch)
    world.revert_msg(world.watch2, "report_risk", 1, ELEVATED, value=BOND, message="ERR_EPOCH_OUT_OF_RANGE")
    assert claim_balance(world, world.watch2) == 0


def test_get_watchtower_rejects_bad_address(world):
    with world.vm.expect_revert("ERR_INVALID_PARAM"):
        world.view("get_watchtower", "nope")


def test_claimable_view_is_case_insensitive(world):
    world.feeds.all_agree(1, ELEVATED)
    world.report(1, ELEVATED)
    mixed = "0x" + hex_of(world.watch)[2:].upper()
    assert world.view("claimable_of", mixed) == str(BOND)


def test_governor_cannot_claim_slashed_bonds(world):
    world.feeds.serve(1, "404", "404", "404")
    world.report(1, CRITICAL)
    world.revert_msg(world.gov, "claim_payout", message="ERR_NO_CLAIMABLE_BALANCE")
    assert world.state()["insurance_reserve_wei"] == str(BOND)


# ===========================================================================
# 5. Consensus validator (leader/validator agreement logic)
# ===========================================================================


def after_report(world, specs, claim=ELEVATED, epoch=1):
    world.feeds.serve(epoch, *specs)
    return world.report(epoch, claim)


def test_validator_accepts_identical_observation(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    assert world.vm.run_validator() is True


def test_validator_accepts_identical_rejection(world):
    after_report(world, ["404", "404", "404"], claim=CRITICAL)
    assert world.vm.run_validator() is True


def test_validator_accepts_identical_quorum_failure(world):
    after_report(world, [("ok", 1), "404", "down"])
    assert world.vm.run_validator() is True


def test_validator_tolerates_one_extra_outage_when_quorum_survives(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    world.vm.clear_mocks()
    world.feeds.serve(1, ("ok", 1), ("ok", 1), "down")
    assert world.vm.run_validator() is True


def test_validator_rejects_leader_verified_when_quorum_vanishes(world):
    after_report(world, [("ok", 1), ("ok", 1), "down"])
    world.vm.clear_mocks()
    world.feeds.serve(1, ("ok", 1), "down", "down")
    assert world.vm.run_validator() is False


def test_validator_rejects_forged_verified_leader(world):
    after_report(world, ["404", "404", "404"], claim=ELEVATED)
    forged = {"verdict": VERIFIED, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64}
    assert world.vm.run_validator(leader_result=forged) is False


def test_validator_rejects_forged_rejection_of_an_honest_report(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    forged = {"verdict": REJECTED, "risk_level": 0, "source_count": 3, "announcement_hash": "b" * 64}
    assert world.vm.run_validator(leader_result=forged) is False


def test_validator_rejects_wrong_announcement_hash(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    honest = world.vm._captured_validators[-1][0]
    forged = dict(honest, announcement_hash="c" * 64)
    assert world.vm.run_validator(leader_result=forged) is False


def test_validator_rejects_wrong_tier(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    honest = world.vm._captured_validators[-1][0]
    assert world.vm.run_validator(leader_result=dict(honest, risk_level=2)) is False


def test_validator_rejects_leader_error(world):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    assert world.vm.run_validator(leader_error=Exception("boom")) is False


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"verdict": 1},
        {"verdict": 1, "risk_level": 1, "source_count": 3},
        {"verdict": 1, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64, "extra": 1},
        {"verdict": True, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": True, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": 1, "source_count": True, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": "1", "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 3, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": -1, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": 3, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": -1, "source_count": 3, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": 1, "source_count": 4, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": 1, "source_count": 1, "announcement_hash": "a" * 64},
        {"verdict": 1, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 63},
        {"verdict": 1, "risk_level": 1, "source_count": 3, "announcement_hash": "Z" * 64},
        {"verdict": 1, "risk_level": 1, "source_count": 3, "announcement_hash": 5},
        {"verdict": 2, "risk_level": 1, "source_count": 1, "announcement_hash": ""},
        {"verdict": 2, "risk_level": -1, "source_count": 1, "announcement_hash": "a" * 64},
        {"verdict": 1.5, "risk_level": 1, "source_count": 3, "announcement_hash": "a" * 64},
        "verified",
        None,
        [1, 1, 3, "a"],
    ],
)
def test_validator_rejects_malformed_or_inconsistent_payloads(world, payload):
    after_report(world, [("ok", 1), ("ok", 1), ("ok", 1)])
    assert world.vm.run_validator(leader_result=payload) is False


# ===========================================================================
# 6. Governance: feed rotation timelock and governor handover
# ===========================================================================

NEW_BASE_A = BASE_A.replace(SHA, SHA2)
NEW_BASE_B = BASE_B.replace(SHA, SHA2)


def new_op(name):
    return hex_of(create_address(name))


def propose(world, slot=0, base=None, op=None, sender=None):
    base = base or GOOD[slot].replace(SHA, SHA2)
    return world.tx(sender or world.gov, "propose_feed_rotation", slot, base, op or new_op(f"new_op_{slot}"))


def test_rotation_eta_is_exactly_seven_days(world):
    world.warp_to(1000)
    eta = propose(world)
    assert eta == T0_TS + 1000 + 7 * DAY
    assert world.view("get_feed_sources")[0]["rotation_eta"] == eta


def test_rotation_visible_before_execution(world):
    propose(world, 1, op=new_op("opx"))
    s = world.view("get_feed_sources")[1]
    assert s["pending_base_url"] == NEW_BASE_B and s["pending_operator"] == new_op("opx")
    assert s["base_url"] == BASE_B  # live registry untouched


def test_non_governor_cannot_propose(world):
    world.revert_msg(world.alice, "propose_feed_rotation", 0, NEW_BASE_A, new_op("z"), message="ERR_UNAUTHORIZED")


def test_non_governor_cannot_execute_or_cancel(world):
    propose(world)
    world.advance(7 * DAY)
    world.revert_msg(world.alice, "execute_feed_rotation", 0, message="ERR_UNAUTHORIZED")
    world.revert_msg(world.alice, "cancel_feed_rotation", 0, message="ERR_UNAUTHORIZED")


def test_execute_before_timelock_reverts(world):
    propose(world)
    world.advance(7 * DAY - 1)
    world.revert_msg(world.gov, "execute_feed_rotation", 0, message="ERR_TIMELOCK")


def test_execute_at_exact_eta_succeeds(world):
    propose(world)
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    s = world.view("get_feed_sources")[0]
    assert s["base_url"] == NEW_BASE_A and s["rotation_eta"] == 0 and s["pending_base_url"] == ""


def test_execute_after_expiry_reverts(world):
    propose(world)
    world.advance(14 * DAY + 1)
    world.revert_msg(world.gov, "execute_feed_rotation", 0, message="expired")


def test_execute_last_second_before_expiry_succeeds(world):
    propose(world)
    world.advance(14 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)


def test_execute_without_proposal_reverts(world):
    world.revert_msg(world.gov, "execute_feed_rotation", 0, message="no rotation pending")


def test_cancel_clears_proposal(world):
    propose(world)
    world.tx(world.gov, "cancel_feed_rotation", 0)
    assert world.view("get_feed_sources")[0]["rotation_eta"] == 0
    world.advance(8 * DAY)
    world.revert_msg(world.gov, "execute_feed_rotation", 0, message="no rotation pending")


def test_cancel_without_proposal_reverts(world):
    world.revert_msg(world.gov, "cancel_feed_rotation", 0, message="no rotation pending")


def test_reproposal_restarts_the_clock(world):
    propose(world)
    world.advance(5 * DAY)
    propose(world, op=new_op("second"))
    world.advance(3 * DAY)
    world.revert_msg(world.gov, "execute_feed_rotation", 0, message="ERR_TIMELOCK")
    world.advance(4 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    assert world.view("get_feed_sources")[0]["operator"] == new_op("second")


@pytest.mark.parametrize("slot", [3, 4, 99])
def test_rotation_slot_out_of_range(world, slot):
    world.revert_msg(world.gov, "propose_feed_rotation", slot, NEW_BASE_A, new_op("q"), message="ERR_INVALID_FEED_SOURCE")
    world.revert_msg(world.gov, "execute_feed_rotation", slot, message="slot out of range")
    world.revert_msg(world.gov, "cancel_feed_rotation", slot, message="slot out of range")


def test_rotation_rejects_wrong_host(world):
    world.revert_msg(world.gov, "propose_feed_rotation", 0, NEW_BASE_B, new_op("q"), message="host must be exactly")


def test_rotation_rejects_branch_ref(world):
    world.revert_msg(world.gov, "propose_feed_rotation", 0, BASE_A.replace(SHA, "main"), new_op("q"), message="40-hex")


def test_rotation_rejects_operator_already_running_another_feed(world):
    world.revert_msg(
        world.gov, "propose_feed_rotation", 0, NEW_BASE_A, hex_of(world.ops[1]), message="operator already runs another feed"
    )


def test_rotation_allows_keeping_own_operator(world):
    propose(world, 0, op=hex_of(world.ops[0]))
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    assert world.view("get_feed_sources")[0]["base_url"] == NEW_BASE_A


def test_rotation_rejects_governor_as_operator(world):
    world.revert_msg(world.gov, "propose_feed_rotation", 0, NEW_BASE_A, hex_of(world.gov), message="governor cannot operate")


def test_rotation_rejects_bad_operator_hex(world):
    world.revert_msg(world.gov, "propose_feed_rotation", 0, NEW_BASE_A, "0xnope", message="ERR_INVALID_PARAM")


def test_swap_attack_is_caught_at_execution(world):
    # propose slot0 -> new operator X, then slot1 -> same X: second proposal is fine
    # alone, but whichever executes second must fail the uniqueness check.
    x = new_op("shared")
    propose(world, 0, op=x)
    propose(world, 1, op=x)
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    world.revert_msg(world.gov, "execute_feed_rotation", 1, message="operator already runs another feed")


def test_rotation_changes_what_reports_read(world):
    propose(world, 0)
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    # old slot-A pin now serves a different (wrong) tier; the new pin serves the truth
    world.vm.mock_web(rf"raw\.githubusercontent\.com/moltaphet/AegisMacro/{SHA}/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, CRITICAL)})
    world.vm.mock_web(rf"raw\.githubusercontent\.com/moltaphet/AegisMacro/{SHA2}/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, ELEVATED)})
    world.vm.mock_web(r"cdn\.jsdelivr\.net/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, ELEVATED)})
    world.vm.mock_web(r"raw\.githack\.com/.*epoch_1\.json$", {"status": 200, "body": feed_doc(1, ELEVATED)})
    assert world.report(1, ELEVATED)["verdict"] == VERIFIED


def test_rotation_does_not_disturb_other_slots(world):
    propose(world, 2)
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 2)
    feeds = world.view("get_feed_sources")
    assert feeds[0]["base_url"] == BASE_A and feeds[1]["base_url"] == BASE_B
    assert feeds[2]["base_url"] == BASE_C.replace(SHA, SHA2)


def test_hosts_remain_distinct_after_rotation(world):
    for slot in range(3):
        propose(world, slot)
    world.advance(7 * DAY)
    for slot in range(3):
        world.tx(world.gov, "execute_feed_rotation", slot)
    hosts = [f["host"] for f in world.view("get_feed_sources")]
    ops = [f["operator"] for f in world.view("get_feed_sources")]
    assert len(set(hosts)) == 3 and len(set(ops)) == 3


def test_governor_handover_two_step(world):
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    assert world.state()["pending_governor"] == hex_of(world.alice)
    assert world.state()["governor"].lower() == hex_of(world.gov)  # unchanged until accepted
    world.tx(world.alice, "accept_governor")
    assert world.state()["governor"].lower() == hex_of(world.alice)
    assert world.state()["pending_governor"] == ""


def test_old_governor_loses_power_after_handover(world):
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    world.tx(world.alice, "accept_governor")
    world.revert_msg(world.gov, "propose_feed_rotation", 0, NEW_BASE_A, new_op("n"), message="ERR_UNAUTHORIZED")
    propose(world, sender=world.alice)


def test_only_proposed_governor_may_accept(world):
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    world.revert_msg(world.bob, "accept_governor", message="ERR_UNAUTHORIZED")


def test_accept_without_proposal_reverts(world):
    world.revert_msg(world.alice, "accept_governor", message="no governor handover pending")


def test_only_governor_may_propose_governor(world):
    world.revert_msg(world.alice, "propose_governor", hex_of(world.alice), message="ERR_UNAUTHORIZED")


def test_feed_operator_cannot_become_governor(world):
    world.revert_msg(world.gov, "propose_governor", hex_of(world.ops[0]), message="cannot be governor")


def test_propose_governor_rejects_bad_address(world):
    world.revert_msg(world.gov, "propose_governor", "bogus", message="ERR_INVALID_PARAM")


def test_governor_has_no_fund_path(world):
    # run a full economy, then prove the governor holds no claim on anything
    world.feeds.serve(1, "404", "404", "404")
    world.report(1, CRITICAL)
    world.seed(ATTO)
    world.assert_conserved()
    assert claim_balance(world, world.gov) == 0
    world.revert_msg(world.gov, "claim_payout", message="ERR_NO_CLAIMABLE_BALANCE")
    world.revert_msg(world.gov, "withdraw_liquidity", ATTO, message="ERR_INVALID_PARAM")


# ===========================================================================
# 7. Lending sandbox: liquidity, collateral, borrow, repay, withdraw
# ===========================================================================


def shares_of(world, who):
    return int(world.position(who)["lp_shares"])


def test_first_supplier_gets_one_to_one_shares(world):
    assert world.seed(ATTO // 2) == str(ATTO // 2)
    s = world.state()
    assert s["total_shares"] == str(ATTO // 2) and s["pool_cash_wei"] == str(ATTO // 2)
    world.assert_conserved()


def test_second_supplier_is_priced_at_pool_value(world):
    world.seed(ATTO)
    assert world.seed(2 * ATTO, who=world.alice) == str(2 * ATTO)
    assert shares_of(world, world.lp) == ATTO and shares_of(world, world.alice) == 2 * ATTO


def test_zero_supply_reverts(world):
    world.revert_msg(world.lp, "seed_liquidity", value=0, message="ERR_INVALID_PARAM")


def test_withdraw_liquidity_round_trip_is_exact(world):
    world.seed(ATTO)
    assert world.tx(world.lp, "withdraw_liquidity", ATTO) == str(ATTO)
    assert world.state()["pool_cash_wei"] == "0" and world.state()["total_shares"] == "0"
    world.assert_conserved()


def test_withdraw_more_shares_than_owned_reverts(world):
    world.seed(ATTO)
    world.revert_msg(world.lp, "withdraw_liquidity", ATTO + 1, message="invalid share amount")
    world.revert_msg(world.alice, "withdraw_liquidity", 1, message="invalid share amount")
    world.revert_msg(world.lp, "withdraw_liquidity", 0, message="invalid share amount")


def test_withdraw_liquidity_blocked_by_outstanding_loans(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    funded.revert_msg(funded.lp, "withdraw_liquidity", 10 * ATTO, message="ERR_INSUFFICIENT_LIQUIDITY")
    assert funded.tx(funded.lp, "withdraw_liquidity", 2 * ATTO) == str(2 * ATTO)
    funded.assert_conserved()


def test_deposit_collateral_accumulates(world):
    world.deposit(world.alice, ATTO)
    world.deposit(world.alice, 2 * ATTO)
    assert world.position(world.alice)["collateral_wei"] == str(3 * ATTO)
    assert world.state()["total_collateral_wei"] == str(3 * ATTO)
    world.assert_conserved()


def test_zero_deposit_reverts(world):
    world.revert_msg(world.alice, "deposit_collateral", value=0, message="ERR_INVALID_PARAM")


def test_borrow_without_collateral_reverts(funded):
    funded.revert_msg(funded.alice, "borrow", 1, message="ERR_LTV_EXCEEDED")


def test_borrow_zero_reverts(funded):
    funded.deposit(funded.alice, ATTO)
    funded.revert_msg(funded.alice, "borrow", 0, message="ERR_INVALID_PARAM")


def test_borrow_beyond_pool_cash_reverts(world):
    world.seed(ATTO)
    world.deposit(world.alice, 10 * ATTO)
    world.revert_msg(world.alice, "borrow", ATTO + 1, message="ERR_INSUFFICIENT_LIQUIDITY")


@pytest.mark.parametrize("level", [NORMAL, ELEVATED, CRITICAL])
def test_max_ltv_boundary_is_exact_for_each_tier(funded, level):
    if level != NORMAL:
        funded.set_tier(level)
    ltv = TIERS[level]["max_ltv_bps"]
    funded.deposit(funded.alice, 10 * ATTO)
    cap = 10 * ATTO * ltv // 10000
    funded.revert_msg(funded.alice, "borrow", cap + 1, message="ERR_LTV_EXCEEDED")
    funded.tx(funded.alice, "borrow", cap)
    funded.revert_msg(funded.alice, "borrow", 1, message="ERR_LTV_EXCEEDED")
    pos = funded.position(funded.alice)
    assert pos["current_ltv_bps"] == ltv and pos["over_limit"] is False
    funded.assert_conserved()


@pytest.mark.parametrize("level", [NORMAL, ELEVATED, CRITICAL])
@pytest.mark.parametrize("coll", [1, 2, 3, 7, 13, 101, 9999, 10001])
def test_ltv_is_exact_integer_for_tiny_collateral(direct_vm, direct_deploy, level, coll):
    w = World(direct_vm, direct_deploy)
    w.deployed()
    w.seed(ATTO)
    if level != NORMAL:
        w.set_tier(level)
    ltv = TIERS[level]["max_ltv_bps"]
    w.deposit(w.alice, coll)
    cap = coll * ltv // 10000  # floor: the largest debt with debt/coll <= ltv/10000
    if cap > 0:
        w.tx(w.alice, "borrow", cap)
        w.revert_msg(w.alice, "borrow", 1, message="ERR_LTV_EXCEEDED")
    else:
        w.revert_msg(w.alice, "borrow", 1, message="ERR_LTV_EXCEEDED")
    w.assert_conserved()


def test_borrow_pays_out_and_updates_buckets(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    assert funded.tx(funded.alice, "borrow", 4 * ATTO) == str(4 * ATTO)
    s = funded.state()
    assert s["pool_cash_wei"] == str(6 * ATTO) and s["total_borrows_wei"] == str(4 * ATTO)
    pos = funded.position(funded.alice)
    assert pos["debt_wei"] == str(4 * ATTO) and pos["principal_wei"] == str(4 * ATTO)
    funded.assert_conserved()


def test_borrow_capacity_view_respects_pool_cash(world):
    world.seed(ATTO)
    world.deposit(world.alice, 10 * ATTO)
    assert world.position(world.alice)["borrowable_wei"] == str(ATTO)


def test_withdraw_collateral_without_debt(world):
    world.deposit(world.alice, 5 * ATTO)
    assert world.tx(world.alice, "withdraw", 2 * ATTO) == str(3 * ATTO)
    assert world.state()["total_collateral_wei"] == str(3 * ATTO)
    world.assert_conserved()


def test_withdraw_more_than_collateral_reverts(world):
    world.deposit(world.alice, ATTO)
    world.revert_msg(world.alice, "withdraw", ATTO + 1, message="invalid collateral amount")
    world.revert_msg(world.alice, "withdraw", 0, message="invalid collateral amount")
    world.revert_msg(world.bob, "withdraw", 1, message="invalid collateral amount")


def test_withdraw_blocked_when_it_breaks_ltv(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 4 * ATTO)  # needs >= 5 GEN collateral at 80%
    funded.revert_msg(funded.alice, "withdraw", 5 * ATTO + 1, message="ERR_LTV_EXCEEDED")
    funded.tx(funded.alice, "withdraw", 5 * ATTO)
    funded.assert_conserved()


def test_repay_partial_applies_to_principal_when_no_interest(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 4 * ATTO)
    out = funded.tx(funded.alice, "repay", value=ATTO)
    assert out["paid_wei"] == str(ATTO) and out["interest_paid_wei"] == "0" and out["principal_paid_wei"] == str(ATTO)
    assert out["remaining_debt_wei"] == str(3 * ATTO) and out["reserve_cut_wei"] == "0"
    funded.assert_conserved()


def test_repay_without_debt_reverts(funded):
    funded.revert_msg(funded.alice, "repay", value=ATTO, message="ERR_NO_DEBT")


def test_repay_zero_reverts(funded):
    funded.deposit(funded.alice, ATTO)
    funded.tx(funded.alice, "borrow", ATTO // 2)
    funded.revert_msg(funded.alice, "repay", value=0, message="ERR_INVALID_PARAM")


def test_overpayment_is_refunded_via_claimable(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    out = funded.tx(funded.alice, "repay", value=3 * ATTO)
    assert out["paid_wei"] == str(ATTO) and out["refund_claimable_wei"] == str(2 * ATTO)
    assert claim_balance(funded, funded.alice) == 2 * ATTO
    assert funded.position(funded.alice)["debt_wei"] == "0"
    funded.assert_conserved()


@pytest.mark.parametrize("level,rate", [(NORMAL, 400), (ELEVATED, 750), (CRITICAL, 1200)])
def test_one_year_interest_matches_tier_rate_exactly(funded, level, rate):
    if level != NORMAL:
        funded.set_tier(level)
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    funded.advance(YEAR)
    pos = funded.position(funded.alice)
    assert int(pos["debt_wei"]) == ATTO + ATTO * rate // 10000
    assert int(pos["interest_wei"]) == ATTO * rate // 10000


@pytest.mark.parametrize("level", [NORMAL, ELEVATED, CRITICAL])
def test_reserve_factor_cut_is_exact_per_tier(funded, level):
    if level != NORMAL:
        funded.set_tier(level)
    rate, rf = TIERS[level]["base_borrow_rate_bps"], TIERS[level]["reserve_factor_bps"]
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    funded.advance(YEAR)
    interest = ATTO * rate // 10000
    out = funded.tx(funded.alice, "repay", value=ATTO + interest)
    assert out["interest_paid_wei"] == str(interest) and out["principal_paid_wei"] == str(ATTO)
    cut = interest * rf // 10000
    assert out["reserve_cut_wei"] == str(cut)
    s = funded.state()
    assert s["reserve_pool_wei"] == str(cut)
    assert s["pool_cash_wei"] == str(10 * ATTO + interest - cut)
    assert s["total_borrows_wei"] == "0"
    funded.assert_conserved()


def test_interest_is_paid_before_principal(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    funded.advance(YEAR)
    interest = ATTO * 400 // 10000
    out = funded.tx(funded.alice, "repay", value=interest // 2)
    assert out["interest_paid_wei"] == str(interest // 2) and out["principal_paid_wei"] == "0"
    assert funded.position(funded.alice)["principal_wei"] == str(ATTO)


def test_lp_value_grows_by_interest_net_of_reserve(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    funded.advance(YEAR)
    interest = 8 * ATTO * 400 // 10000
    funded.tx(funded.alice, "repay", value=8 * ATTO + interest)
    cut = interest * 1000 // 10000
    assert funded.position(funded.lp)["lp_value_wei"] == str(10 * ATTO + interest - cut)
    funded.assert_conserved()


def test_late_lp_cannot_steal_accrued_yield(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    funded.advance(YEAR)
    funded.tx(funded.alice, "repay", value=8 * ATTO + 8 * ATTO * 400 // 10000)
    value_before = int(funded.position(funded.lp)["lp_value_wei"])
    funded.seed(10 * ATTO, who=funded.bob)
    assert int(funded.position(funded.lp)["lp_value_wei"]) >= value_before - 1
    assert int(funded.position(funded.bob)["lp_value_wei"]) <= 10 * ATTO
    funded.assert_conserved()


def test_tightening_leaves_existing_loans_over_limit_but_repayable(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    funded.set_tier(CRITICAL)
    pos = funded.position(funded.alice)
    assert pos["over_limit"] is True and pos["max_ltv_bps"] == 5000
    funded.revert_msg(funded.alice, "borrow", 1, message="ERR_LTV_EXCEEDED")
    funded.revert_msg(funded.alice, "withdraw", 1, message="ERR_LTV_EXCEEDED")
    funded.tx(funded.alice, "repay", value=3 * ATTO)
    assert funded.position(funded.alice)["over_limit"] is False or int(funded.position(funded.alice)["debt_wei"]) > 5 * ATTO
    funded.assert_conserved()


def test_relaxing_the_tier_unlocks_borrowing(funded):
    funded.set_tier(CRITICAL)
    funded.deposit(funded.alice, 10 * ATTO)
    funded.revert_msg(funded.alice, "borrow", 6 * ATTO, message="ERR_LTV_EXCEEDED")
    funded.set_tier(NORMAL)
    funded.tx(funded.alice, "borrow", 6 * ATTO)
    funded.assert_conserved()


def test_interest_accrues_at_old_rate_up_to_the_tier_change(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    funded.advance(YEAR // 2)
    funded.set_tier(CRITICAL)  # accrues half a year at 4% first
    funded.advance(YEAR // 2)  # then half a year at 12%
    idx1 = ATTO + ATTO * 400 * (YEAR // 2) // (10000 * YEAR)
    idx2 = idx1 + idx1 * 1200 * (YEAR // 2) // (10000 * YEAR)
    assert int(funded.position(funded.alice)["debt_wei"]) == (ATTO * idx2 + ATTO - 1) // ATTO


def test_debt_rounds_up_never_down(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 3)
    funded.advance(1)
    # 3 wei grows by ~3.8e-9 wei in one second at 4%: ceil makes that a full wei
    assert funded.position(funded.alice)["debt_wei"] == "4"
    funded.deposit(funded.alice, 1)  # realise it
    assert funded.state()["total_borrows_wei"] == "4"
    funded.assert_conserved()


def test_one_wei_loan_round_trip(funded):
    funded.deposit(funded.alice, 10)
    funded.tx(funded.alice, "borrow", 1)
    funded.tx(funded.alice, "repay", value=1)
    assert funded.position(funded.alice)["debt_wei"] == "0"
    funded.assert_conserved()


def test_positions_are_independent(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.deposit(funded.bob, 5 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    assert funded.position(funded.bob)["debt_wei"] == "0"
    funded.revert_msg(funded.bob, "repay", value=ATTO, message="ERR_NO_DEBT")
    funded.tx(funded.bob, "withdraw", 5 * ATTO)
    funded.assert_conserved()


def test_get_position_rejects_bad_address(world):
    with world.vm.expect_revert("ERR_INVALID_PARAM"):
        world.view("get_position", "xyz")


def test_full_lifecycle_leaves_exactly_the_reserve(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 8 * ATTO)
    funded.advance(YEAR)
    interest = 8 * ATTO * 400 // 10000
    funded.tx(funded.alice, "repay", value=8 * ATTO + interest)
    funded.tx(funded.alice, "withdraw", 10 * ATTO)
    shares = shares_of(funded, funded.lp)
    funded.tx(funded.lp, "withdraw_liquidity", shares)
    s = funded.state()
    cut = interest * 1000 // 10000
    assert s["reserve_pool_wei"] == str(cut)
    assert int(s["contract_balance_wei"]) == cut
    assert s["pool_cash_wei"] == "0" and s["total_collateral_wei"] == "0" and s["total_borrows_wei"] == "0"
    funded.assert_conserved()


def test_tier_binding_changes_reserve_factor_applied_to_old_debt(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", ATTO)
    funded.advance(YEAR)
    funded.set_tier(CRITICAL)  # 40% reserve factor from now on
    pos = funded.position(funded.alice)
    interest = int(pos["interest_wei"])
    out = funded.tx(funded.alice, "repay", value=int(pos["debt_wei"]))
    assert out["reserve_cut_wei"] == str(int(out["interest_paid_wei"]) * 4000 // 10000)
    assert int(out["interest_paid_wei"]) >= interest


# ===========================================================================
# 8. Bounty economics and Sybil/farming defence
# ===========================================================================


def fund_reserve(world, borrow=8 * ATTO):
    """Create a reserve pool through real interest: returns its size."""
    world.seed(10 * ATTO)
    world.deposit(world.alice, 10 * ATTO)
    world.tx(world.alice, "borrow", borrow)
    world.advance(YEAR)
    interest = borrow * 400 // 10000
    world.tx(world.alice, "repay", value=borrow + interest)
    return int(world.state()["reserve_pool_wei"])


def test_bounty_is_ten_percent_of_bond_on_a_real_shift(world):
    pool = fund_reserve(world)
    assert pool >= BOND // 10
    out = world.set_tier(ELEVATED)
    assert out["bounty_wei"] == str(BOND // 10)
    assert claim_balance(world, world.watch) == BOND + BOND // 10
    assert int(world.state()["reserve_pool_wei"]) == pool - BOND // 10
    world.assert_conserved()


def test_bounty_is_capped_by_the_reserve_pool(world):
    pool = fund_reserve(world, borrow=ATTO)  # small pool
    assert pool < BOND // 10
    out = world.set_tier(ELEVATED)
    assert out["bounty_wei"] == str(pool)
    assert world.state()["reserve_pool_wei"] == "0"
    world.assert_conserved()


def test_no_bounty_when_pool_is_empty(world):
    out = world.set_tier(ELEVATED)
    assert out["bounty_wei"] == "0"


def test_no_bounty_for_reconfirming_the_same_tier(world):
    fund_reserve(world)
    world.set_tier(ELEVATED)
    out = world.set_tier(ELEVATED)  # new epoch, same tier
    assert out["bounty_wei"] == "0" and out["level_changed"] is False


def test_no_bounty_for_inconclusive_or_rejected_reports(world):
    fund_reserve(world)
    pool = world.state()["reserve_pool_wei"]
    world.feeds.serve(1, ("ok", 1), "404", "down")
    assert world.report(1, ELEVATED)["bounty_wei"] == "0"
    world.vm.clear_mocks()
    world.feeds.serve(1, "404", "404", "404")
    assert world.report(1, ELEVATED)["bounty_wei"] == "0"
    assert world.state()["reserve_pool_wei"] == pool


def test_sybil_farming_one_bounty_per_epoch(world):
    fund_reserve(world)
    world.feeds.all_agree(1, ELEVATED)
    winners = 0
    for who in (world.watch, world.watch2, world.alice, world.bob):
        try:
            out = world.report(1, ELEVATED, sender=who)
        except Exception:
            continue
        winners += int(out["bounty_wei"]) > 0
    assert winners == 1


def test_bounty_is_always_smaller_than_the_bond(world):
    fund_reserve(world)
    out = world.set_tier(ELEVATED)
    assert int(out["bounty_wei"]) < BOND


def test_slash_flows_only_to_insurance_never_to_claimables(world):
    world.feeds.serve(1, "404", "404", "404")
    world.report(1, CRITICAL)
    s = world.state()
    assert s["insurance_reserve_wei"] == str(BOND) and s["total_claimable_wei"] == "0"
    assert s["reserve_pool_wei"] == "0"


def test_insurance_reserve_has_no_public_outflow():
    """Only report_risk (credit) and the state view (read) may mention the
    insurance reserve: nothing public can debit it."""
    tree_ = ast.parse(open(CONTRACT).read())
    for name, (_, fn) in public_methods(tree_).items():
        mentions = "insurance_reserve" in ast.unparse(fn)
        assert mentions == (name in ("report_risk", "get_protocol_state")), name


def test_insurance_reserve_is_only_ever_incremented():
    src = open(CONTRACT).read()
    lines = [ln.strip() for ln in src.splitlines() if "self.insurance_reserve =" in ln]
    assert lines and all("int(self.insurance_reserve) + " in ln or ln.endswith("= 0") for ln in lines), lines


# ===========================================================================
# 9. Conservation: randomised op sequences against the independent ledger
# ===========================================================================


def run_random_session(world, seed, steps=70):
    import random

    rng = random.Random(seed)
    users = [world.alice, world.bob, world.carol]
    world.seed(20 * ATTO)
    epoch = 0
    for _ in range(steps):
        who = rng.choice(users)
        op = rng.choice(["dep", "dep", "borrow", "repay", "withdraw", "warp", "tier", "lp", "claim"])
        try:
            if op == "dep":
                world.deposit(who, rng.randint(1, 3 * ATTO))
            elif op == "borrow":
                p = world.position(who)
                room = int(p["borrowable_wei"])
                if room > 0:
                    world.tx(who, "borrow", rng.randint(1, room))
            elif op == "repay":
                p = world.position(who)
                if int(p["debt_wei"]) > 0:
                    world.tx(who, "repay", value=rng.randint(1, int(p["debt_wei"]) + 5))
            elif op == "withdraw":
                p = world.position(who)
                c = int(p["collateral_wei"])
                if c > 0:
                    world.tx(who, "withdraw", rng.randint(1, c))
            elif op == "warp":
                world.advance(rng.randint(1, 40 * DAY))
            elif op == "tier":
                epoch = int(world.view("get_risk_status")["last_applied_epoch"]) + 1
                world.set_tier(rng.choice([NORMAL, ELEVATED, CRITICAL]), epoch=epoch)
            elif op == "lp":
                world.seed(rng.randint(1, 2 * ATTO), who=world.lp)
            elif op == "claim":
                if claim_balance(world, who) > 0:
                    world.tx(who, "claim_payout")
        except Exception:
            pass  # a revert must leave the ledger untouched; checked below
        world.assert_conserved()
    return users


@pytest.mark.parametrize("seed", list(range(12)))
def test_random_sessions_conserve_every_wei(world, seed):
    run_random_session(world, seed)


@pytest.mark.parametrize("seed", [100, 101, 102])
def test_debt_ledgers_sum_to_total_borrows_after_sync(world, seed):
    users = run_random_session(world, seed, steps=50)
    for u in users:  # a 1-wei deposit realises each borrower's interest
        world.deposit(u, 1)
    total = sum(int(world.position(u)["debt_wei"]) for u in users)
    assert total == int(world.state()["total_borrows_wei"])
    assert sum(int(world.position(u)["collateral_wei"]) for u in users) == int(world.state()["total_collateral_wei"])
    world.assert_conserved()


@pytest.mark.parametrize("seed", [100, 101, 102, 103])
def test_unrealised_interest_aggregate_matches_per_borrower_sum(world, seed):
    """norm_borrows is maintained incrementally. Once every borrower is synced there
    is no unrealised interest left, so the LP (sole shareholder) is worth exactly
    idle cash + realised loans, to within a wei of rounding per borrower."""
    users = run_random_session(world, seed, steps=50)
    for u in users:  # a 1-wei deposit realises each borrower's interest
        world.deposit(u, 1)
    s = world.state()
    assert shares_of(world, world.lp) == int(s["total_shares"])
    value = int(world.position(world.lp)["lp_value_wei"])
    assets = int(s["pool_cash_wei"]) + int(s["total_borrows_wei"])
    assert 0 <= value - assets <= len(users)


@pytest.mark.parametrize("seed", [200, 201, 202])
def test_everyone_can_exit_without_stranding_funds(world, seed):
    users = run_random_session(world, seed, steps=45)
    for u in users:
        pos = world.position(u)
        if int(pos["debt_wei"]) > 0:
            world.tx(u, "repay", value=int(pos["debt_wei"]))
    for u in users:
        pos = world.position(u)
        if int(pos["collateral_wei"]) > 0:
            world.tx(u, "withdraw", int(pos["collateral_wei"]))
        if claim_balance(world, u) > 0:
            world.tx(u, "claim_payout")
    s = world.state()
    assert s["total_collateral_wei"] == "0" and s["total_borrows_wei"] == "0"
    world.assert_conserved()
    for lp in (world.lp,):
        sh = shares_of(world, lp)
        if sh:
            world.tx(lp, "withdraw_liquidity", sh)
    world.assert_conserved()


# ===========================================================================
# 9b. Audit regressions: LP share pricing vs. unrealised interest, and
#     governor / feed-operator separation across concurrent proposals
# ===========================================================================


def borrow_a_year(world):
    """10 GEN of LP cash, 8 GEN borrowed, then one year at the 4% NORMAL rate
    with NO borrower touching the pool: 0.32 GEN of interest accrued, none of
    it yet realised into total_borrows."""
    world.deposit(world.alice, 10 * ATTO)
    world.tx(world.alice, "borrow", 8 * ATTO)
    world.advance(YEAR)
    accrued = 8 * ATTO * 400 // 10000
    assert int(world.state()["total_borrows_wei"]) == 8 * ATTO  # stale: the bug's precondition
    return accrued


def test_new_lp_is_priced_with_interest_accrued_before_entry(funded):
    accrued = borrow_a_year(funded)
    funded.tx(funded.bob, "seed_liquidity", value=10 * ATTO)
    # fair price: (idle 2 + borrowed 8 + accrued 0.32) GEN backing 10 GEN of shares
    assert shares_of(funded, funded.bob) == (10 * ATTO * 10 * ATTO) // (10 * ATTO + accrued)
    funded.assert_conserved()


def test_new_lp_cannot_claim_interest_accrued_before_entry(funded):
    borrow_a_year(funded)
    funded.tx(funded.bob, "seed_liquidity", value=10 * ATTO)
    owed = int(funded.position(funded.alice)["debt_wei"])
    funded.tx(funded.alice, "repay", value=owed)
    bob_out = int(funded.tx(funded.bob, "withdraw_liquidity", shares_of(funded, funded.bob)))
    # bob paid in 10 GEN after the interest had already accrued; he must not
    # walk out with more than that (the stale price let him take ~0.16 GEN extra)
    assert bob_out <= 10 * ATTO
    funded.assert_conserved()


def test_withdrawing_lp_is_paid_interest_accrued_before_exit(funded):
    accrued = borrow_a_year(funded)
    # 1 of 10 shares, with 10.32 GEN of assets behind them
    out = funded.tx(funded.lp, "withdraw_liquidity", ATTO)
    assert int(out) == ATTO * (10 * ATTO + accrued) // (10 * ATTO)
    funded.assert_conserved()


def test_lp_share_value_view_includes_accrued_interest(funded):
    accrued = borrow_a_year(funded)
    assert int(funded.position(funded.lp)["lp_value_wei"]) == 10 * ATTO + accrued


def test_share_price_is_continuous_across_a_borrower_sync(funded):
    accrued = borrow_a_year(funded)
    before = int(funded.position(funded.lp)["lp_value_wei"])
    funded.deposit(funded.alice, 1)  # realises alice's interest into total_borrows
    assert int(funded.state()["total_borrows_wei"]) == 8 * ATTO + accrued
    after = int(funded.position(funded.lp)["lp_value_wei"])
    assert abs(after - before) <= 1


def test_share_pricing_without_borrows_is_unchanged(funded):
    funded.advance(YEAR)
    assert int(funded.position(funded.lp)["lp_value_wei"]) == 10 * ATTO
    funded.tx(funded.bob, "seed_liquidity", value=5 * ATTO)
    assert shares_of(funded, funded.bob) == 5 * ATTO


def test_pending_governor_cannot_be_proposed_as_feed_operator(world):
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    world.revert_msg(world.gov, "propose_feed_rotation", 0, NEW_BASE_A, hex_of(world.alice),
                     message="pending governor cannot operate a feed")
    assert world.state()["pending_governor"] == hex_of(world.alice)


def test_pending_feed_operator_cannot_be_proposed_as_governor(world):
    propose(world, slot=0, op=hex_of(world.alice))
    world.revert_msg(world.gov, "propose_governor", hex_of(world.alice),
                     message="a pending feed operator cannot be governor")
    assert world.state()["pending_governor"] == ""


def test_concurrent_role_proposals_for_one_address_cannot_both_land(world):
    """The audit's scenario: queue a governor handover and a feed rotation for
    the same address and let both execute. Whichever is queued second is refused,
    so no ordering ends with one address holding both roles."""
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    with world.vm.expect_revert("ERR_INVALID_FEED_SOURCE"):
        propose(world, slot=1, op=hex_of(world.alice))
    world.tx(world.alice, "accept_governor")
    sources = world.view("get_feed_sources")
    assert hex_of(world.alice) not in [f["operator"] for f in sources]
    assert world.state()["governor"].lower() == hex_of(world.alice)


def test_cancelled_rotation_frees_the_address_for_governor(world):
    propose(world, slot=0, op=hex_of(world.alice))
    world.tx(world.gov, "cancel_feed_rotation", 0)
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    world.tx(world.alice, "accept_governor")
    assert world.state()["governor"].lower() == hex_of(world.alice)


def test_executed_rotation_operator_cannot_be_governor(world):
    op = new_op("rot_then_gov")
    propose(world, slot=0, op=op)
    world.advance(7 * DAY)
    world.tx(world.gov, "execute_feed_rotation", 0)
    world.revert_msg(world.gov, "propose_governor", op, message="a feed operator cannot be governor")


def test_repointing_pending_governor_rechecks_pending_operators(world):
    world.tx(world.gov, "propose_governor", hex_of(world.alice))
    propose(world, slot=0, op=hex_of(world.bob))
    world.revert_msg(world.gov, "propose_governor", hex_of(world.bob),
                     message="a pending feed operator cannot be governor")
    assert world.state()["pending_governor"] == hex_of(world.alice)


# ===========================================================================
# 10. Static audits: no floats, no URL parameter, access control shape
# ===========================================================================


@pytest.fixture(scope="module")
def tree():
    return ast.parse(open(CONTRACT).read())


def test_source_has_no_float_literals(tree):
    floats = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, float)]
    assert floats == []


def test_source_never_calls_float(tree):
    calls = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "float"]
    assert calls == []


def test_source_has_no_true_division(tree):
    bad = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div)]
    bad += [n.lineno for n in ast.walk(tree) if isinstance(n, ast.AugAssign) and isinstance(n.op, ast.Div)]
    assert bad == []


def test_source_avoids_nondeterministic_modules(tree):
    banned = {"random", "time", "os", "sys", "subprocess", "socket", "math", "decimal", "fractions", "statistics"}
    imported = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            imported |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module:
            imported.add(n.module.split(".")[0])
    assert imported.isdisjoint(banned), imported & banned


def test_source_has_no_python_float_annotation(tree):
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "float" not in names


def public_methods(tree):
    cls = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AegisMacro"][0]
    out = {}
    for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
        for d in fn.decorator_list:
            text = ast.unparse(d)
            if text.startswith("gl.public"):
                out[fn.name] = (text, fn)
    return out


def test_report_risk_takes_no_url(tree):
    _, fn = public_methods(tree)["report_risk"]
    assert [a.arg for a in fn.args.args] == ["self", "epoch", "claimed_level"]


def test_no_public_method_accepts_a_url_except_governed_rotation(tree):
    allowed = {"propose_feed_rotation", "is_valid_feed_url"}
    for name, (_, fn) in public_methods(tree).items():
        for a in fn.args.args:
            if "url" in a.arg.lower():
                assert name in allowed, (name, a.arg)


def test_governance_methods_check_the_governor(tree):
    for name in ("propose_feed_rotation", "execute_feed_rotation", "cancel_feed_rotation", "propose_governor"):
        _, fn = public_methods(tree)[name]
        assert "_only_governor" in ast.unparse(fn), name


def test_views_are_marked_view_and_writes_are_not(tree):
    pm = public_methods(tree)
    for name, (deco, _) in pm.items():
        if name.startswith("get_") or name in ("whoami", "claimable_of", "is_valid_feed_url", "preview_aggregate"):
            assert deco == "gl.public.view", name
        else:
            assert deco.startswith("gl.public.write"), name


def test_payable_surface_is_exactly_the_value_entry_points(tree):
    payable = {n for n, (d, _) in public_methods(tree).items() if d == "gl.public.write.payable"}
    assert payable == {"report_risk", "seed_liquidity", "deposit_collateral", "repay"}


def test_no_storage_access_inside_the_nondet_closures(tree):
    cls = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AegisMacro"][0]
    resolve = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_resolve"][0]
    for inner in [n for n in ast.walk(resolve) if isinstance(n, ast.FunctionDef) and n is not resolve]:
        assert "self." not in ast.unparse(inner), inner.name


def _contains_float(obj):
    if isinstance(obj, float):
        return True
    if isinstance(obj, dict):
        return any(_contains_float(k) or _contains_float(v) for k, v in obj.items())
    if isinstance(obj, (list, tuple)):
        return any(_contains_float(v) for v in obj)
    return False


def test_no_view_ever_returns_a_float(funded):
    funded.deposit(funded.alice, 10 * ATTO)
    funded.tx(funded.alice, "borrow", 4 * ATTO)
    funded.advance(37 * DAY)
    funded.feeds.all_agree(1, ELEVATED)
    rid = funded.report(1, ELEVATED)["report_id"]
    a = hex_of(funded.alice)
    outputs = [
        funded.view("get_risk_status"),
        funded.view("get_risk_tiers"),
        funded.view("get_feed_sources"),
        funded.view("get_protocol_state"),
        funded.view("get_report", rid),
        funded.view("get_report_count"),
        funded.view("get_watchtower", hex_of(funded.watch)),
        funded.view("get_position", a),
        funded.view("claimable_of", a),
        funded.view("whoami"),
        funded.view("is_valid_feed_url", 0, BASE_A),
        funded.view("preview_aggregate", json.dumps([OK1, OK1, NF]), 1, 1),
    ]
    for out in outputs:
        assert not _contains_float(out), out


def test_every_returned_value_is_a_plain_abi_type(funded):
    def check(o):
        assert isinstance(o, (int, str, bool, list, dict)), type(o)
        if isinstance(o, dict):
            [check(v) for v in o.values()]
        if isinstance(o, list):
            [check(v) for v in o]

    check(funded.view("get_protocol_state"))
    check(funded.view("get_feed_sources"))
    check(funded.view("get_risk_tiers"))
    check(funded.position(funded.alice))


def test_state_survives_json_round_trip(funded):
    s = funded.state()
    assert json.loads(json.dumps(s)) == s  # nothing exotic (no bytes, no float)


# ===========================================================================
# 11. Real fixtures from deployments/mock_feeds served through the contract
# ===========================================================================

FIXTURE_FILES = sorted(p for p in FEEDS_DIR.glob("*/epoch_*.json"))


def serve_fixture_tree(vm):
    hosts = {"a": r"raw\.githubusercontent\.com", "b": r"cdn\.jsdelivr\.net", "c": r"raw\.githack\.com"}
    for p in FIXTURE_FILES:
        feed = p.parent.name
        n = p.stem.split("_")[1]
        vm.mock_web(rf"{hosts[feed]}/.*/mock_feeds/{feed}/epoch_{n}\.json$", {"status": 200, "body": p.read_text()})
    vm.mock_web(r"epoch_\d+\.json$", {"status": 404, "body": "404: Not Found"})


FIXTURE_CASES = [
    (1, ELEVATED, VERIFIED),
    (1, CRITICAL, REJECTED),
    (1, NORMAL, REJECTED),
    (2, CRITICAL, VERIFIED),
    (3, NORMAL, VERIFIED),
    (4, ELEVATED, VERIFIED),
    (5, NORMAL, VERIFIED),
    (5, CRITICAL, REJECTED),
    (6, NORMAL, QUORUM_FAILURE),
    (6, ELEVATED, QUORUM_FAILURE),
    (6, CRITICAL, QUORUM_FAILURE),
    (7, CRITICAL, VERIFIED),
    (8, ELEVATED, REJECTED),
    (9, ELEVATED, REJECTED),
    (12, NORMAL, REJECTED),
]


@pytest.mark.parametrize("epoch,claim,expected", FIXTURE_CASES)
def test_committed_fixtures_resolve_as_documented(world, epoch, claim, expected):
    serve_fixture_tree(world.vm)
    assert world.report(epoch, claim)["verdict"] == expected


def test_fixture_directory_is_populated():
    assert len(FIXTURE_FILES) >= 20


@pytest.mark.parametrize("path", [p for p in FIXTURE_FILES if not (p.parent.name == "c" and p.stem == "epoch_7")], ids=lambda p: f"{p.parent.name}/{p.name}")
def test_fixture_files_are_valid_records(path):
    doc = json.loads(path.read_text())
    assert doc["schema"] == "aegismacro.feed.v1"
    assert doc["mock"] is True, "fixtures must be labelled synthetic"
    assert doc["epoch"] == int(path.stem.split("_")[1])
    assert doc["risk_level"] in (0, 1, 2)
    assert 0 < len(doc["event_id"]) <= 64
    assert len(path.read_bytes()) < 8192


def test_malformed_fixture_is_really_malformed():
    with pytest.raises(ValueError):
        json.loads((FEEDS_DIR / "c" / "epoch_7.json").read_text())


def test_fixture_sequence_end_to_end(world):
    serve_fixture_tree(world.vm)
    steps = [(1, ELEVATED), (2, CRITICAL), (3, NORMAL)]
    for ep, lvl in steps:
        assert world.report(ep, lvl)["verdict"] == VERIFIED
        assert world.view("get_risk_status")["risk_level"] == lvl
    assert world.view("get_risk_status")["shift_count"] == 3
    world.assert_conserved()
