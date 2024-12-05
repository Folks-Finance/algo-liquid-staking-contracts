from pyteal import *
from common.checks import *
from common.inner_txn import *
from consensus_state_v1 import *

initialised_key = ConsensusV1GlobalState.INITIALISED
admin_key = ConsensusV1GlobalState.ADMIN
register_admin_key = ConsensusV1GlobalState.REGISTER_ADMIN
x_algo_id_key = ConsensusV1GlobalState.X_ALGO_ID
time_delay_key = ConsensusV1GlobalState.TIME_DELAY
num_proposers_key = ConsensusV1GlobalState.NUM_PROPOSERS
min_proposer_balance_key = ConsensusV1GlobalState.MIN_PROPOSER_BALANCE
max_proposer_balance_key = ConsensusV1GlobalState.MAX_PROPOSER_BALANCE
fee_key = ConsensusV1GlobalState.FEE
premium_key = ConsensusV1GlobalState.PREMIUM
total_pending_stake_key = ConsensusV1GlobalState.TOTAL_PENDING_STAKE
total_active_stake_key = ConsensusV1GlobalState.TOTAL_ACTIVE_STAKE
total_rewards_key = ConsensusV1GlobalState.TOTAL_REWARDS
total_unclaimed_fees_key = ConsensusV1GlobalState.TOTAL_UNCLAIMED_FEES
can_immediate_mint_key = ConsensusV1GlobalState.CAN_IMMEDIATE_MINT
can_delay_mint_key = ConsensusV1GlobalState.CAN_DELAY_MINT


@Subroutine(TealType.bytes)
def get_proposer(proposer_index: Expr):
    return Seq(
        Assert(proposer_index < App.globalGet(num_proposers_key)),
        BoxExtract(
            ProposersBox.NAME,
            proposer_index * ProposersBox.ADDRESS_SIZE,
            ProposersBox.ADDRESS_SIZE
        )
    )


@Subroutine(TealType.none)
def mint_x_algo(amt: Expr, receiver: Expr):
    return Seq(
        InnerTxnBuilder.Begin(),
        get_transfer_inner_txn(Global.current_application_address(), receiver, amt, App.globalGet(x_algo_id_key)),
        InnerTxnBuilder.Submit(),
    )


router = Router(
    name="Consensus",
    bare_calls=BareCallActions(
        update_application=OnCompleteAction(action=Approve(), call_config=CallConfig.CALL),
    )
)


@router.method(no_op=CallConfig.CREATE)
def create(
    admin: abi.Address,
    register_admin: abi.Address,
    min_proposer_balance: abi.Uint64,
    max_proposer_balance: abi.Uint64,
    premium: abi.Uint64,
    fee: abi.Uint64
) -> Expr:
    return Seq(
        App.globalPut(initialised_key, Int(1)),
        App.globalPut(admin_key, admin.get()),
        App.globalPut(register_admin_key, register_admin.get()),
        App.globalPut(time_delay_key, Int(int(86400))),
        App.globalPut(num_proposers_key, Int(int(0))),
        App.globalPut(min_proposer_balance_key, min_proposer_balance.get()),
        App.globalPut(max_proposer_balance_key, max_proposer_balance.get()),
        App.globalPut(fee_key, fee.get()),
        App.globalPut(premium_key, premium.get()),
        App.globalPut(total_pending_stake_key, Int(0)),
        App.globalPut(total_active_stake_key, Int(0)),
        App.globalPut(total_rewards_key, Int(0)),
        App.globalPut(total_unclaimed_fees_key, Int(0)),
        App.globalPut(can_immediate_mint_key, Int(1)),
        App.globalPut(can_delay_mint_key, Int(0)),
    )


@router.method(no_op=CallConfig.CALL)
def initialise(proposer: abi.Account) -> Expr:
    proposer_rekeyed_to = proposer.params().auth_address()

    create_x_algo = Seq(
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetConfig,
            TxnField.config_asset_name: Bytes("Governance xAlgo"),
            TxnField.config_asset_unit_name: Bytes("xALGO"),
            TxnField.config_asset_total: Int(int(10e15)),
            TxnField.config_asset_decimals: Int(6),
            TxnField.config_asset_reserve: Global.current_application_address(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
    )

    return Seq(
        # create xALGO and store its asset id
        create_x_algo,
        App.globalPut(x_algo_id_key, InnerTxn.created_asset_id()),
        # verify proposer has been rekeyed to the app
        proposer_rekeyed_to,
        Assert(proposer_rekeyed_to.hasValue()),
        Assert(proposer_rekeyed_to.value() == Global.current_application_address()),
        # add proposer
        App.globalPut(num_proposers_key, Int(1)),
        Assert(BoxCreate(ProposersBox.NAME, ProposersBox.ADDRESS_SIZE * ProposersBox.MAX_NUM_PROPOSERS)),
        BoxReplace(ProposersBox.NAME, Int(0), proposer.address()),
        Assert(BoxCreate(Concat(AddedProposerBox.NAME, proposer.address()), Int(0))),
     )


@router.method(no_op=CallConfig.CALL)
def mint(send_algo: abi.PaymentTransaction) -> Expr:
    return Seq(
        Assert(send_algo.get().receiver() == get_proposer(Int(0))),
        mint_x_algo(send_algo.get().amount(), Txn.sender()),
        App.globalPut(total_active_stake_key, App.globalGet(total_active_stake_key) + send_algo.get().amount()),
    )


pragma(compiler_version="0.26.1")
approval_program, clear_program, contract = router.compile_program(
    version=9, optimize=OptimizeOptions(scratch_slots=True)
)

if __name__ == "__main__":
    print(approval_program)
