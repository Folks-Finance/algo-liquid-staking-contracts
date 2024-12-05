from enum import EnumMeta
from pyteal import Bytes, Int


class ConsensusV1GlobalState(EnumMeta):
    INITIALISED = Bytes("initialised")
    ADMIN = Bytes("admin")
    REGISTER_ADMIN = Bytes("register_admin")
    X_ALGO_ID = Bytes("x_algo_id")
    TIME_DELAY = Bytes("time_delay")
    NUM_PROPOSERS = Bytes("num_proposers")
    MIN_PROPOSER_BALANCE = Bytes("min_proposer_balance")
    MAX_PROPOSER_BALANCE = Bytes("max_proposer_balance")
    FEE = Bytes("fee")  # 4 d.p
    PREMIUM = Bytes("premium")  # 16 d.p
    TOTAL_PENDING_STAKE = Bytes("total_pending_stake")
    TOTAL_ACTIVE_STAKE = Bytes("total_active_stake")
    TOTAL_REWARDS = Bytes("total_rewards")
    TOTAL_UNCLAIMED_FEES = Bytes("total_unclaimed_fees")
    CAN_IMMEDIATE_MINT = Bytes("can_immediate_mint")
    CAN_DELAY_MINT = Bytes("can_delay_mint")


class ProposersBox(EnumMeta):
    NAME = Bytes("pr")
    ADDRESS_SIZE = Int(32)
    MAX_NUM_PROPOSERS = Int(30)


class AddedProposerBox(EnumMeta):
    NAME = Bytes("ap")
    SIZE = Int(0)
