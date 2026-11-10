"""wire: engine objects -> the JSON frames in apps/web/lib/contract.ts.

``sample_frames()`` is one block of real engine output wrapped in frames. It is also written to
``apps/web/tests/fixtures/wire-frames.json``, where a vitest test feeds it through the UI's own
``parseFrame`` and reducer. The fixture test below fails whenever this module's output changes,
so the two sides cannot drift apart silently. After an intended change, regenerate it with

    UPDATE_WIRE_FIXTURE=1 uv run pytest apps/api/tests/test_wire.py
"""

import json
import os
from pathlib import Path
from typing import Any, cast

import pytest
from mev_arena_api import wire
from simulation_engine.block_builder import BuilderPolicy
from simulation_engine.events import (
    BlockProposed,
    Envelope,
    EventType,
    Payload,
    TransactionAccepted,
    TransactionDropped,
    TransactionRejected,
    events_for_block,
)
from simulation_engine.execution import WorldState, execute_block, state_hash
from simulation_engine.mempool import Admission
from simulation_engine.models import (
    SCALE,
    AccountBalance,
    ExecutionReceipt,
    MarketState,
    Side,
    Transaction,
    TransactionStatus,
)

FIXTURE = Path(__file__).parents[2] / "web" / "tests" / "fixtures" / "wire-frames.json"
MARKET = MarketState(
    "eth-usdc", 1_000 * SCALE, 1_000_000 * SCALE, fee_bps=30, base_asset="ETH", quote_asset="USDC"
)
START = {"ETH": 100 * SCALE, "USDC": 100_000 * SCALE}
ACCOUNTS = ("noise-1", "noise-2", "arb-0", "sandwich-0")
HEIGHT = 5
"""The sample block. The snapshot is taken after block 4."""


def _tx(
    tx_id: str,
    account: str,
    *,
    side: Side = Side.SELL,
    amount: int = SCALE,
    min_out: int = 0,
    fee: int = 0,
    submitted_at: int = 4,
    expires_at: int = 9,
) -> Transaction:
    return Transaction(
        id=tx_id,
        idempotency_key=f"{account}:{tx_id}",
        account_id=account,
        nonce=0,
        market_id="eth-usdc",
        side=side,
        amount_in=amount,
        min_amount_out=min_out,
        priority_fee=fee,
        submitted_at=submitted_at,
        expires_at=expires_at,
    )


def _world() -> WorldState:
    balances = {
        (a, asset): AccountBalance(a, asset, amount)
        for a in ACCOUNTS
        for asset, amount in START.items()
    }
    return WorldState(markets={"eth-usdc": MARKET}, balances=balances)


# In the pool after block 4: one that runs in block 5 but asks for too much, one about to expire.
GREEDY = _tx("4.0", "noise-1", amount=2 * SCALE, min_out=10_000 * SCALE)
STALE = _tx("4.1", "noise-2", submitted_at=3, expires_at=4)
# Arrives in block 5 and executes first under PRIORITY_FEE.
ARB = _tx("5.0", "arb-0", amount=3 * SCALE, fee=7, submitted_at=5)


def _envelope(i: int, payload: Payload) -> Envelope:
    return Envelope(
        event_id=f"00000000-0000-4000-8000-{i:012d}",
        event_type=cast(EventType, type(payload).__name__),
        event_version=1,
        aggregate_id="eth-usdc",
        occurred_at="2026-11-10T00:00:15.000Z",
        correlation_id="00000000-0000-4000-8000-b10c00000005",
        causation_id="00000000-0000-4000-8000-b10c00000005",
        payload=payload,
    )


def _simulation(height: int) -> wire.Json:
    return wire.simulation_state_json(
        status="running",
        height=height,
        policy=BuilderPolicy.PRIORITY_FEE,
        seed=42,
        capacity=10,
        block_interval_ms=3_000,
        next_block_at="2026-11-10T00:00:18.000Z",
    )


def sample_frames() -> list[wire.Json]:
    """A snapshot after block 4, then every event of block 5, then the new simulation state."""
    world = _world()
    block = (ARB, GREEDY)
    after, receipts = execute_block(world, block, HEIGHT)
    root = state_hash(after)
    payloads: list[Payload] = [
        TransactionDropped(STALE.id, "expired"),
        TransactionAccepted(ARB),
        TransactionRejected("sandwich-0:5:0", "sandwich-0", Admission.STALE_NONCE),
        BlockProposed(HEIGHT, BuilderPolicy.PRIORITY_FEE, tuple(t.id for t in block)),
        *events_for_block(block, receipts, after, HEIGHT, root),
    ]
    snapshot = wire.snapshot_frame(
        simulation=_simulation(HEIGHT - 1),
        market=wire.market_json(MARKET, reference_price=1_001 * SCALE),
        mempool=[GREEDY, STALE],
        recent_blocks=[],
        accounts=[
            wire.account_info_json(
                a,
                start_base=START["ETH"],
                start_quote=START["USDC"],
                base_balance=world.balance_of(a, "ETH"),
                quote_balance=world.balance_of(a, "USDC"),
            )
            for a in ACCOUNTS
        ],
    )
    events = [wire.event_frame(_envelope(i, p)) for i, p in enumerate(payloads)]
    return [snapshot, *events, wire.simulation_frame(_simulation(HEIGHT))]


def _roundtrip(frame: wire.Json) -> Any:
    return json.loads(wire.dumps(frame))


def test_the_ui_fixture_matches_what_this_module_sends():
    frames = [_roundtrip(f) for f in sample_frames()]
    if os.environ.get("UPDATE_WIRE_FIXTURE") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(frames, indent=2) + "\n")
    assert json.loads(FIXTURE.read_text()) == frames, (
        "run with UPDATE_WIRE_FIXTURE=1, see docstring"
    )


def test_the_sample_covers_every_event_type_the_ui_reads():
    frames = [_roundtrip(f) for f in sample_frames()]
    types = {f["event"]["eventType"] for f in frames if f["kind"] == "event"}
    assert types == {
        "TransactionDropped",
        "TransactionAccepted",
        "TransactionRejected",
        "BlockProposed",
        "TransactionExecuted",
        "SwapExecuted",
        "MarketPriceUpdated",
        "BlockCommitted",
    }


def test_a_transaction_goes_out_camel_case_with_amounts_as_strings():
    assert wire.tx_json(_tx("5.0", "arb-0", amount=3 * SCALE, fee=7, submitted_at=5)) == {
        "id": "5.0",
        "idempotencyKey": "arb-0:5.0",
        "accountId": "arb-0",
        "nonce": 0,
        "marketId": "eth-usdc",
        "side": "sell",
        "amountIn": "3000000000000000000",
        "minAmountOut": "0",
        "priorityFee": "7",
        "submittedAt": 5,
        "expiresAt": 9,
    }


def test_amounts_past_2_to_the_53_survive_exactly():
    huge = 2**53 + 1  # a JavaScript number would round this to 2**53
    frame = _roundtrip(wire.market_json(MarketState("m", huge, huge * 3, fee_bps=30)))
    assert frame["baseReserve"] == str(huge)
    assert frame["quoteReserve"] == str(huge * 3)


def test_a_failed_receipt_carries_its_error_code_and_zero_out():
    world = _world()
    _, receipts = execute_block(world, (GREEDY,), HEIGHT)
    assert receipts[0].status is TransactionStatus.FAILED
    assert wire.receipt_json(GREEDY, receipts[0]) == {
        "transactionId": "4.0",
        "accountId": "noise-1",
        "position": 0,
        "status": "failed",
        "side": "sell",
        "amountIn": "2000000000000000000",
        "amountOut": "0",
        "slippageBps": 0,
        "errorCode": "slippage",
    }


def test_a_block_summary_counts_and_orders_its_receipts():
    world = _world()
    _, receipts = execute_block(world, (ARB, GREEDY), HEIGHT)
    summary = _roundtrip(
        wire.block_summary_json(
            height=HEIGHT,
            policy=BuilderPolicy.FIFO,
            block=(ARB, GREEDY),
            receipts=receipts,
            state_root="ab",
        )
    )
    assert (summary["executed"], summary["failed"]) == (1, 1)
    assert summary["transactionIds"] == ["5.0", "4.0"]
    assert [r["position"] for r in summary["receipts"]] == [0, 1]


def test_a_receipt_for_another_transaction_is_refused():
    receipt = ExecutionReceipt("other", HEIGHT, 0, TransactionStatus.EXECUTED, 1, 1, 1, 0, 0)
    with pytest.raises(ValueError, match="not for transaction"):
        wire.receipt_json(ARB, receipt)
    with pytest.raises(ValueError, match="2 transactions, 1 receipts"):
        wire.block_summary_json(
            height=HEIGHT,
            policy=BuilderPolicy.FIFO,
            block=(ARB, GREEDY),
            receipts=[receipt],
            state_root="",
        )


@pytest.mark.parametrize(
    ("account", "kind"), [("noise-3", "noise"), ("arb-0", "arb"), ("sandwich-1", "sandwich")]
)
def test_the_account_kind_comes_from_the_id_prefix(account: str, kind: str):
    assert wire.account_kind(account) == kind


def test_an_account_outside_the_contract_kinds_is_refused():
    with pytest.raises(ValueError, match="does not start with"):
        wire.account_kind("whale-1")


def test_a_seed_past_2_to_the_53_is_refused():
    with pytest.raises(ValueError, match="does not fit"):
        wire.simulation_state_json(
            status="paused",
            height=0,
            policy=BuilderPolicy.FIFO,
            seed=2**53,
            capacity=10,
            block_interval_ms=3_000,
            next_block_at=None,
        )
