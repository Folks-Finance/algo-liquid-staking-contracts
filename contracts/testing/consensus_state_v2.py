from enum import EnumMeta
from pyteal import Bytes, Int


class ConsensusV2GlobalState(EnumMeta):
    INITIALISED = Bytes("init")
    ADMIN = Bytes("admin")
    REGISTER_ADMIN = Bytes("register_admin")
    XGOV_ADMIN = Bytes("xgov_admin")
    X_ALGO_ID = Bytes("x_algo_id")
    TIME_DELAY = Bytes("time_delay")
    NUM_PROPOSERS = Bytes("num_proposers")
    MAX_PROPOSER_BALANCE = Bytes("max_proposer_balance")
    FEE = Bytes("fee")  # 4 d.p
    PREMIUM = Bytes("premium")  # 16 d.p
    LAST_PROPOSERS_ACTIVE_BALANCE = Bytes("last_proposers_active_balance")
    TOTAL_PENDING_STAKE = Bytes("total_pending_stake")
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
