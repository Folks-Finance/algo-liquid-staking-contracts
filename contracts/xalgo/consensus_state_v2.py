from enum import EnumMeta
from pyteal import abi, Bytes, Int


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
    TIMESTAMP = Int(0)  # uint64
    ADMIN = Int(8)  # 32 bytes
    SIZE = Int(40)


class SCUpdateBox(EnumMeta):
    NAME = Bytes("sc")
    TIMESTAMP = Int(0)  # uint64
    APPROVAL = Int(8)  # 32 bytes
    CLEAR = Int(40)  # 32 bytes
    SIZE = Int(72)


class DelayMintBox(EnumMeta):
    NAME_PREFIX = Bytes("dm")
    RECEIVER = Int(0)  # 32 bytes
    STAKE = Int(32)  # uint64
    ROUND = Int(40)  # uint64
    SIZE = Int(48)


class XAlgoRate(abi.NamedTuple):
    algo_balance: abi.Field[abi.Uint64]
    x_algo_circulating_supply: abi.Field[abi.Uint64]
    proposers_balances: abi.Field[abi.DynamicBytes] # interpreted as uint64[] (workaround for output)
