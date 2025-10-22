from typing import Literal as L
from pyteal import *
from common.math_lib import ONE_4_DP, ONE_16_DP, mul_scale, minimum
from common.checks import *
from common.inner_txn import *
from consensus_state_v3 import *

initialised_key = ConsensusV3GlobalState.INITIALISED
admin_key = ConsensusV3GlobalState.ADMIN
register_admin_key = ConsensusV3GlobalState.REGISTER_ADMIN
xgov_admin_key = ConsensusV3GlobalState.XGOV_ADMIN
x_algo_id_key = ConsensusV3GlobalState.X_ALGO_ID
time_delay_key = ConsensusV3GlobalState.TIME_DELAY
num_proposers_key = ConsensusV3GlobalState.NUM_PROPOSERS
max_proposer_balance_key = ConsensusV3GlobalState.MAX_PROPOSER_BALANCE
fee_key = ConsensusV3GlobalState.FEE
premium_key = ConsensusV3GlobalState.PREMIUM
last_proposers_active_balance_key = ConsensusV3GlobalState.LAST_PROPOSERS_ACTIVE_BALANCE
total_pending_stake_key = ConsensusV3GlobalState.TOTAL_PENDING_STAKE
total_unclaimed_fees_key = ConsensusV3GlobalState.TOTAL_UNCLAIMED_FEES
can_immediate_mint_key = ConsensusV3GlobalState.CAN_IMMEDIATE_MINT
can_delay_mint_key = ConsensusV3GlobalState.CAN_DELAY_MINT


@Subroutine(TealType.none)
def check_admin_call():
    return Assert(Txn.sender() == App.globalGet(admin_key))


@Subroutine(TealType.uint64)
def is_register_admin_call():
    return Txn.sender() == App.globalGet(register_admin_key)


@Subroutine(TealType.none)
def check_register_admin_call():
    return Assert(is_register_admin_call())


@Subroutine(TealType.none)
def check_xgov_admin_call():
    return Assert(Txn.sender() == App.globalGet(xgov_admin_key))


@Subroutine(TealType.none)
def check_proposer_admin_call(proposer_index: Expr):
    box = BoxGet(Concat(AddedProposerBox.NAME, get_proposer(proposer_index)))

    return Seq(
        # check proposer box exists
        box,
        Assert(box.hasValue()),
        # check sender is active admin
        Assert(Global.latest_timestamp() > ExtractUint64(box.value(), AddedProposerBox.TIMESTAMP)),
        Assert(Txn.sender() == Extract(box.value(), AddedProposerBox.ADMIN, Int(32))),
    )

@Subroutine(TealType.none)
def replace_proposer_admin(proposer_index: abi.Uint8, timestamp: Expr, admin: abi.Address):
    return App.box_put(
        Concat(AddedProposerBox.NAME, get_proposer(proposer_index.get())),
        Concat(Itob(timestamp), admin.get())
    )


@Subroutine(TealType.none)
def check_fee():
    return Assert(App.globalGet(fee_key) <= Int(int(1e4)))  # cannot exceed 100%


@Subroutine(TealType.none)
def check_premium():
    return Assert(App.globalGet(premium_key) <= Int(int(0.01e16)))  # cannot exceed 1%


@Subroutine(TealType.uint64)
def get_app_algo_balance():
    return Balance(Global.current_application_address()) - MinBalance(Global.current_application_address())


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


@Subroutine(TealType.uint64)
def get_proposer_balance(proposer_index: Expr, include_min: Expr):
    proposer = ScratchVar(TealType.bytes)
    return Seq(
        proposer.store(get_proposer(proposer_index)),
        Balance(proposer.load()) - If(include_min, Int(0), MinBalance(proposer.load()))
    )


@Subroutine(TealType.uint64)
def get_proposers_algo_balance(include_min: Expr):
    num_proposers = ScratchVar(TealType.uint64)
    total = ScratchVar(TealType.uint64)
    i = ScratchVar(TealType.uint64)

    return Seq(
        # common vars accessed in loop
        num_proposers.store(App.globalGet(num_proposers_key)),
        total.store(Int(0)),
        # loop through proposers and sum balances
        For(i.store(Int(0)), i.load() < num_proposers.load(), i.store(i.load() + Int(1))).Do(
            total.store(total.load() + get_proposer_balance(i.load(), include_min))
        ),
        # return total
        total.load()
    )


@Subroutine(TealType.uint64)
def get_x_algo_circulating_supply():
    bal = AssetHolding.balance(Global.current_application_address(), App.globalGet(x_algo_id_key))
    return Seq(
        bal,
        Assert(bal.hasValue()),
        Int(int(10e15)) - bal.value()
    )


@Subroutine(TealType.none)
def sync_proposers_active_balance_and_unclaimed_fees():
    proposers_active_balance = ScratchVar(TealType.uint64)

    total_rewards_delta = proposers_active_balance.load() - App.globalGet(last_proposers_active_balance_key)
    unclaimed_fees_delta = mul_scale(total_rewards_delta, App.globalGet(fee_key), ONE_4_DP)

    return Seq(
        # calculate new proposers active balance to derive delta between now and last sync
        proposers_active_balance.store(get_proposers_algo_balance(Int(0)) - App.globalGet(total_pending_stake_key)),
        # update unclaimed fees
        App.globalPut(total_unclaimed_fees_key, App.globalGet(total_unclaimed_fees_key) + unclaimed_fees_delta),
        App.globalPut(last_proposers_active_balance_key, proposers_active_balance.load()),
    )


@Subroutine(TealType.none)
def receive_algo_to_proposers(amt: Expr):
    num_proposers = ScratchVar(TealType.uint64)
    i = ScratchVar(TealType.uint64)

    rem = ScratchVar(TealType.uint64)
    total_bal = ScratchVar(TealType.uint64)
    proposer_bal = ScratchVar(TealType.uint64)
    target = ScratchVar(TealType.uint64)
    alloc = ScratchVar(TealType.uint64)

    return Seq(
        # common vars accessed in loop
        num_proposers.store(App.globalGet(num_proposers_key)),
        total_bal.store(get_proposers_algo_balance(Int(1))),
        target.store(Div(total_bal.load() + amt, num_proposers.load()) + Int(1)), # always round up even if exact div
        # check target doesn't exceed max proposer balance (assumes current approx equal split)
        Assert(target.load() <= App.globalGet(max_proposer_balance_key)),
        # split amount in app account among proposers
        For(
            Seq(i.store(Int(0)), rem.store(amt)),
            And(i.load() < num_proposers.load(), rem.load()),
            i.store(i.load() + Int(1))
        ).Do(
            proposer_bal.store(get_proposer_balance(i.load(), Int(1))),
            If(proposer_bal.load() < target.load(), Seq(
                alloc.store(minimum(target.load() - proposer_bal.load(), rem.load())),
                InnerTxnBuilder.Begin(),
                get_transfer_inner_txn(Global.current_application_address(), get_proposer(i.load()), alloc.load(), Int(0)),
                InnerTxnBuilder.Submit(),
                rem.store(rem.load() - alloc.load()),
            )),
        ),
        # ensure fully allocated algo
        Assert(Not(rem.load())),
    )

@Subroutine(TealType.none)
def send_algo_from_proposers(receiver: Expr, amt: Expr):
    num_proposers = ScratchVar(TealType.uint64)
    i = ScratchVar(TealType.uint64)

    rem = ScratchVar(TealType.uint64)
    total_bal = ScratchVar(TealType.uint64)
    proposer_bal = ScratchVar(TealType.uint64)
    target = ScratchVar(TealType.uint64)
    alloc = ScratchVar(TealType.uint64)

    return Seq(
        # common vars accessed in loop
        num_proposers.store(App.globalGet(num_proposers_key)),
        total_bal.store(get_proposers_algo_balance(Int(1))),
        target.store(Div(total_bal.load() - amt, num_proposers.load())),  # round down
        # no check on min proposer balance (assumes sufficient with current approx equal split)
        # split algo among proposers and collect in app account
        For(
            Seq(i.store(Int(0)), rem.store(amt)),
            And(i.load() < num_proposers.load(), rem.load()),
            i.store(i.load() + Int(1))
        ).Do(
            proposer_bal.store(get_proposer_balance(i.load(), Int(1))),
            If(proposer_bal.load() > target.load(), Seq(
                alloc.store(minimum(proposer_bal.load() - target.load(), rem.load())),
                InnerTxnBuilder.Begin(),
                get_transfer_inner_txn(get_proposer(i.load()), Global.current_application_address(), alloc.load(), Int(0)),
                InnerTxnBuilder.Submit(),
                rem.store(rem.load() - alloc.load()),
            )),
        ),
        # ensure fully allocated algo
        Assert(Not(rem.load())),
        # send total from app account to receiver
        InnerTxnBuilder.Begin(),
        get_transfer_inner_txn(Global.current_application_address(), receiver, amt, Int(0)),
        InnerTxnBuilder.Submit(),
    )


@Subroutine(TealType.none)
def send_unclaimed_fees():
    return Seq(
        sync_proposers_active_balance_and_unclaimed_fees(),
        send_algo_from_proposers( App.globalGet(admin_key), App.globalGet(total_unclaimed_fees_key)),
        App.globalPut(last_proposers_active_balance_key, App.globalGet(last_proposers_active_balance_key) - App.globalGet(total_unclaimed_fees_key)),
        App.globalPut(total_unclaimed_fees_key, Int(0)),
    )


@Subroutine(TealType.none)
def mint_x_algo(amt: Expr, receiver: Expr):
    return Seq(
        InnerTxnBuilder.Begin(),
        get_transfer_inner_txn(Global.current_application_address(), receiver, amt, App.globalGet(x_algo_id_key)),
        InnerTxnBuilder.Submit(),
    )


@Subroutine(TealType.none)
def check_algo_sent(txn: abi.PaymentTransaction, receiver: Expr):
    return Seq(
        Assert(txn.get().type_enum() == TxnType.Payment),
        Assert(txn.get().sender() == Txn.sender()),
        Assert(txn.get().receiver() == receiver),
        Assert(txn.get().close_remainder_to() == Global.zero_address()),
        Assert(txn.get().rekey_to() == Global.zero_address()),
    )


@Subroutine(TealType.none)
def check_x_algo_sent(txn: abi.AssetTransferTransaction):
    return Seq(
        Assert(txn.get().type_enum() == TxnType.AssetTransfer),
        Assert(txn.get().xfer_asset() == App.globalGet(x_algo_id_key)),
        Assert(txn.get().sender() == Txn.sender()),
        Assert(txn.get().asset_receiver() == Global.current_application_address()),
        Assert(txn.get().asset_close_to() == Global.zero_address()),
        Assert(txn.get().close_remainder_to() == Global.zero_address()),
        Assert(txn.get().rekey_to() == Global.zero_address()),
    )


router = Router(
    name="Consensus",
    bare_calls=BareCallActions()
)


@router.method(no_op=CallConfig.CALL)
def initialise() -> Expr:
    return Seq(
        # anyone can call to prevent centralised DOS risk
        rekey_and_close_to_check(),
        # ensure not initialised
        Assert(Not(App.globalGet(initialised_key))),
        App.globalPut(initialised_key, Int(1)),
        # no state to change
    )


@router.method(no_op=CallConfig.CALL)
def update_admin(admin_type: abi.String, new_admin: abi.Address) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check if valid admin type
        Assert(Or(
            admin_type.get() == admin_key,
            admin_type.get() == register_admin_key,
            admin_type.get() == xgov_admin_key,
        )),
        # verify caller is valid
        Assert(Or(Txn.sender() == App.globalGet(admin_key), Txn.sender() == App.globalGet(admin_type.get()))),
        # check address passed is 32 bytes
        address_length_check(new_admin),
        # update admin
        App.globalPut(admin_type.get(), new_admin.get())
    )


@router.method(no_op=CallConfig.CALL)
def schedule_update_sc(approval_sha256: abi.StaticBytes[L[32]], clear_sha256: abi.StaticBytes[L[32]]) -> Expr:
    timestamp = ScratchVar(TealType.uint64)

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is admin
        check_admin_call(),
        # verify program hash are 32 bytes
        Assert(Len(approval_sha256.get()) == Int(32)),
        Assert(Len(clear_sha256.get()) == Int(32)),
        # calculate timestamp and store in scratch space for repeated access
        timestamp.store(Global.latest_timestamp() + App.globalGet(time_delay_key)),
        # can override box
        App.box_put(SCUpdateBox.NAME, Concat(Itob(timestamp.load()), approval_sha256.get(), clear_sha256.get()))
    )


@router.method(update_application=CallConfig.CALL)
def update_sc() -> Expr:
    box = App.box_get(SCUpdateBox.NAME)
    timestamp = ExtractUint64(box.value(), SCUpdateBox.TIMESTAMP)
    approval_sha256 = Extract(box.value(), SCUpdateBox.APPROVAL, Int(32))
    clear_sha256 = Extract(box.value(), SCUpdateBox.CLEAR, Int(32))

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is admin
        check_admin_call(),
        # check box
        box,
        Assert(box.hasValue()),
        Assert(Global.latest_timestamp() > timestamp),
        Assert(approval_sha256 == Sha256(Txn.approval_program())),
        Assert(clear_sha256 == Sha256(Txn.clear_state_program())),
        # delete box
        Assert(App.box_delete(SCUpdateBox.NAME)),
        # refund box min balance
        InnerTxnBuilder.Begin(),
        get_transfer_inner_txn(Global.current_application_address(), Txn.sender(), get_app_algo_balance(), Int(0)),
        InnerTxnBuilder.Submit(),
        # delete initialised
        App.globalPut(initialised_key, Int(0)),
    )


@router.method(no_op=CallConfig.CALL)
def add_proposer(proposer: abi.Account) -> Expr:
    proposer_rekeyed_to = proposer.params().auth_address()
    num_proposers = ScratchVar(TealType.uint64)

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is register admin
        check_register_admin_call(),
        # verify proposer has been rekeyed to the app
        proposer_rekeyed_to,
        Assert(proposer_rekeyed_to.hasValue()),
        Assert(proposer_rekeyed_to.value() == Global.current_application_address()),
        # check num proposers won't exceed max
        num_proposers.store(App.globalGet(num_proposers_key)),
        Assert(num_proposers.load() < ProposersBox.MAX_NUM_PROPOSERS),
        # add proposer, verifying it hasn't already been added
        Assert(BoxCreate(Concat(AddedProposerBox.NAME, proposer.address()), Int(0))),
        BoxReplace(ProposersBox.NAME, num_proposers.load() * ProposersBox.ADDRESS_SIZE, proposer.address()),
        App.globalPut(num_proposers_key, num_proposers.load() + Int(1)),
        # log add proposer
        Log(Concat(MethodSignature("AddProposer(address)"), proposer.address())),
    )


@router.method(no_op=CallConfig.CALL)
def update_max_proposer_balance(new_max_proposer_balance: abi.Uint64) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is admin
        check_admin_call(),
        # set new max proposer balance
        App.globalPut(max_proposer_balance_key, new_max_proposer_balance.get()),
        # log update max proposer balance
        Log(Concat(MethodSignature("UpdateMaxProposerBalance(uint64)"), Itob(new_max_proposer_balance.get()))),
    )


@router.method(no_op=CallConfig.CALL)
def update_fee(new_fee: abi.Uint64) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is admin
        check_admin_call(),
        # claim fees before updating param
        send_unclaimed_fees(),
        # set new fee
        App.globalPut(fee_key, new_fee.get()),
        check_fee(),
        # log update fee
        Log(Concat(MethodSignature("UpdateFee(uint64)"), Itob(new_fee.get()))),
    )


@router.method(no_op=CallConfig.CALL)
def claim_fee() -> Expr:
    return Seq(
        # callable by anyone - fees go to admin, not sender
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # claim fees
        send_unclaimed_fees(),
    )


@router.method(no_op=CallConfig.CALL)
def update_premium(new_premium: abi.Uint64) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is admin
        check_admin_call(),
        # set new premium
        App.globalPut(premium_key, new_premium.get()),
        check_premium(),
        # log update premium
        Log(Concat(MethodSignature("UpdatePremium(uint64)"), Itob(new_premium.get()))),
    )


@router.method(no_op=CallConfig.CALL)
def pause_minting(minting_type: abi.String, to_pause: abi.Bool) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check if valid minting type
        Assert(Or(
            minting_type.get() == can_immediate_mint_key,
            minting_type.get() == can_delay_mint_key,
        )),
        # verify caller is admin
        check_admin_call(),
        # update is paused
        App.globalPut(minting_type.get(), Not(to_pause.get())),
        # log pause minting
        Log(Concat(MethodSignature("PauseMinting(string,uint64)"), minting_type.get(), Itob(to_pause.get()))),
    )


@router.method(no_op=CallConfig.CALL)
def set_proposer_admin(proposer_index: abi.Uint8, new_proposer_admin: abi.Address) -> Expr:
    box_name = ScratchVar(TealType.bytes)
    box = BoxGet(box_name.load())

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check proposer exists
        Assert(proposer_index.get() < App.globalGet(num_proposers_key)),
        # check proposer box exists
        box_name.store(Concat(AddedProposerBox.NAME, get_proposer(proposer_index.get()))),
        box,
        Assert(box.hasValue()),
        # check address passed is 32 bytes
        address_length_check(new_proposer_admin),
        # set proposer admin according to who is sender and if there is an existing proposer admin
        If(
            is_register_admin_call(),
            If(
                Len(box.value()),
                # sender is register admin and there is an existing proposer admin -> delay
                replace_proposer_admin(
                    proposer_index,
                    Global.latest_timestamp() + App.globalGet(time_delay_key),
                    new_proposer_admin
                ),
                # sender is register admin and there is no existing proposer admin -> immediate
                Seq(
                    BoxResize(box_name.load(), AddedProposerBox.SIZE),
                    replace_proposer_admin(proposer_index, Global.latest_timestamp(), new_proposer_admin)
                ),
            ),
            Seq(
                check_proposer_admin_call(proposer_index.get()),
                # sender is proposer admin -> immediate
                replace_proposer_admin(proposer_index, Global.latest_timestamp(), new_proposer_admin)
            )
        ),
    )


@router.method(no_op=CallConfig.CALL)
def register_online(
    send_algo: abi.PaymentTransaction,
    proposer_index: abi.Uint8,
    vote_key: abi.Address,
    sel_key: abi.Address,
    state_proof_key: abi.StaticBytes[L[64]],
    vote_first: abi.Uint64,
    vote_last: abi.Uint64,
    vote_key_dilution: abi.Uint64,
) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is proposer admin
        check_proposer_admin_call(proposer_index.get()),
        # check payment for fee
        check_algo_sent(send_algo, get_proposer(proposer_index.get())),
        # check proposer exists
        Assert(proposer_index.get() < App.globalGet(num_proposers_key)),
        # key registration (with special fee to opt into rewards)
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.KeyRegistration,
            TxnField.sender: get_proposer(proposer_index.get()),
            TxnField.vote_pk: vote_key.get(),
            TxnField.selection_pk: sel_key.get(),
            TxnField.state_proof_pk: state_proof_key.get(),
            TxnField.vote_first: vote_first.get(),
            TxnField.vote_last: vote_last.get(),
            TxnField.vote_key_dilution: vote_key_dilution.get(),
            TxnField.fee: send_algo.get().amount(),
        }),
        InnerTxnBuilder.Submit(),
    )


@router.method(no_op=CallConfig.CALL)
def register_offline(proposer_index: abi.Uint8) -> Expr:
    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is register admin or proposer admin
        If(Not(is_register_admin_call()), check_proposer_admin_call(proposer_index.get())),
        # check proposer exists
        Assert(proposer_index.get() < App.globalGet(num_proposers_key)),
        # key registration
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.KeyRegistration,
            TxnField.sender: get_proposer(proposer_index.get()),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
    )


@router.method(no_op=CallConfig.CALL)
def subscribe_xgov(
    send_algo: abi.PaymentTransaction,
    proposer_index: abi.Uint8,
    xgov_registry: abi.Application,
    voting_address: abi.Address,
) -> Expr:
    xgov_registry_address = xgov_registry.params().address()
    xgov_registry_fee = App.globalGetEx(xgov_registry.application_id(), Bytes("xgov_fee"))

    send_payment = {
        TxnField.sender: Global.current_application_address(),
        TxnField.type_enum: TxnType.Payment,
        TxnField.amount: send_algo.get().amount(),
        TxnField.receiver: xgov_registry_address.value(),
        TxnField.fee: Int(0),
    }

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is xgov admin
        check_xgov_admin_call(),
        # check address passed is 32 bytes
        address_length_check(voting_address),
        # check proposer exists
        Assert(proposer_index.get() < App.globalGet(num_proposers_key)),
        # prepare call
        xgov_registry_address,
        xgov_registry_fee,
        Assert(xgov_registry_address.hasValue()),
        Assert(xgov_registry_fee.hasValue()),
        # check payment for fee
        check_algo_sent(send_algo, Global.current_application_address()),
        Assert(send_algo.get().amount() == xgov_registry_fee.value()),
        # subscribe to xgov
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.MethodCall(
            app_id=xgov_registry.application_id(),
            method_signature="subscribe_xgov(address,pay)void",
            args=[voting_address, send_payment],
            extra_fields={TxnField.sender: get_proposer(proposer_index.get()), TxnField.fee: Int(0)}
        ),
        InnerTxnBuilder.Submit(),
    )


@router.method(no_op=CallConfig.CALL)
def unsubscribe_xgov(proposer_index: abi.Uint8, xgov_registry: abi.Application) -> Expr:
    proposer_address = abi.Address()

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify caller is xgov admin
        check_xgov_admin_call(),
        # check proposer exists
        Assert(proposer_index.get() < App.globalGet(num_proposers_key)),
        # prepare call
        proposer_address.set(get_proposer(proposer_index.get())),
        # unsubscribe from xgov
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.MethodCall(
            app_id=xgov_registry.application_id(),
            method_signature="unsubscribe_xgov(address)void",
            args=[proposer_address],
            extra_fields={TxnField.sender: proposer_address.get(), TxnField.fee: Int(0)}
        ),
        InnerTxnBuilder.Submit(),
    )


@router.method(no_op=CallConfig.CALL)
def immediate_mint(send_algo: abi.PaymentTransaction, receiver: abi.Address, min_received: abi.Uint64) -> Expr:
    algo_sent = send_algo.get().amount()
    algo_balance = ScratchVar(TealType.uint64)
    mint_amount = ScratchVar(TealType.uint64)

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify can immediate mint
        Assert(App.globalGet(can_immediate_mint_key)),
        # check address passed is 32 bytes
        address_length_check(receiver),
        # sync before receiving the algo as to not mistake new algo received for rewards
        sync_proposers_active_balance_and_unclaimed_fees(),
        # check algo sent and distribute among proposers
        check_algo_sent(send_algo, Global.current_application_address()),
        receive_algo_to_proposers(algo_sent),
        # calculate mint amount before we update proposers active balance
        algo_balance.store(App.globalGet(last_proposers_active_balance_key) - App.globalGet(total_unclaimed_fees_key)),
        mint_amount.store(
            If(
                algo_balance.load(),
                mul_scale(
                    mul_scale(algo_sent, get_x_algo_circulating_supply(), algo_balance.load()),
                    ONE_16_DP - App.globalGet(premium_key),
                    ONE_16_DP
                ),
                algo_sent
            )
        ),
        # update proposers active balance considering new algo received
        App.globalPut(last_proposers_active_balance_key, App.globalGet(last_proposers_active_balance_key) + algo_sent),
        # check mint amount and send xALGO to user
        Assert(mint_amount.load()),
        Assert(mint_amount.load() >= min_received.get()),
        mint_x_algo(mint_amount.load(), receiver.get()),
        # log mint
        Log(Concat(
            MethodSignature("ImmediateMint(address,address,uint64,uint64)"),
            Txn.sender(),
            receiver.get(),
            Itob(algo_sent),
            Itob(mint_amount.load()),
        )),
    )


@router.method(no_op=CallConfig.CALL)
def delayed_mint(send_algo: abi.PaymentTransaction, receiver: abi.Address, nonce: abi.StaticBytes[L[2]]) -> Expr:
    algo_sent = send_algo.get().amount()

    box_name = Concat(DelayMintBox.NAME_PREFIX, Txn.sender(), nonce.get())

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # verify can delay mint
        Assert(App.globalGet(can_delay_mint_key)),
        # check address passed is 32 bytes
        address_length_check(receiver),
        # check nonce is 2 bytes
        Assert(Len(nonce.get()) == Int(2)),
        # sync before receiving the algo as to not mistake new algo received for rewards
        sync_proposers_active_balance_and_unclaimed_fees(),
        # check algo sent and distribute among proposers
        check_algo_sent(send_algo, Global.current_application_address()),
        receive_algo_to_proposers(algo_sent),
        # update total pending stake considering new algo received
        App.globalPut(total_pending_stake_key, App.globalGet(total_pending_stake_key) + algo_sent),
        # save in box and fail if box already exists
        Assert(BoxCreate(box_name, DelayMintBox.SIZE)),
        BoxPut(box_name, Concat(receiver.get(), Itob(algo_sent), Itob(Global.round() + Int(320)))),
        # log so can retrieve info for claiming
        Log(Concat(
            MethodSignature("DelayedMint(byte[36],address,address,uint64)"),
            box_name,
            Txn.sender(),
            receiver.get(),
            Itob(algo_sent),
        )),
    )


@router.method(no_op=CallConfig.CALL)
def claim_delayed_mint(minter: abi.Address, nonce: abi.StaticBytes[L[2]]) -> Expr:
    box_name = Concat(DelayMintBox.NAME_PREFIX, minter.get(), nonce.get())
    box = BoxGet(box_name)

    delay_mint_receiver = Extract(box.value(), DelayMintBox.RECEIVER, Int(32))
    delay_mint_stake = ExtractUint64(box.value(), DelayMintBox.STAKE)
    delay_mint_round = ExtractUint64(box.value(), DelayMintBox.ROUND)

    algo_balance = ScratchVar(TealType.uint64)
    mint_amount = ScratchVar(TealType.uint64)

    return Seq(
        # callable by anyone
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check address passed is 32 bytes
        address_length_check(minter),
        # check nonce is 2 bytes
        Assert(Len(nonce.get()) == Int(2)),
        # check box
        box,
        Assert(box.hasValue()),
        Assert(Global.round() >= delay_mint_round),
        # sync
        sync_proposers_active_balance_and_unclaimed_fees(),
        # calculate mint amount before we update proposers active balance
        algo_balance.store(App.globalGet(last_proposers_active_balance_key) - App.globalGet(total_unclaimed_fees_key)),
        mint_amount.store(
            If(
                algo_balance.load(),
                mul_scale(delay_mint_stake, get_x_algo_circulating_supply(), algo_balance.load()),
                delay_mint_stake
            )
        ),
        # update proposers active balance and total stakes considering new algo active
        App.globalPut(last_proposers_active_balance_key, App.globalGet(last_proposers_active_balance_key) + delay_mint_stake),
        App.globalPut(total_pending_stake_key, App.globalGet(total_pending_stake_key) - delay_mint_stake),
        # send xALGO to user
        mint_x_algo(mint_amount.load(), delay_mint_receiver),
        # delete box so cannot claim multiple times
        Assert(BoxDelete(box_name)),
        # give box min balance to sender as incentive
        InnerTxnBuilder.Begin(),
        get_transfer_inner_txn(Global.current_application_address(), Txn.sender(), get_app_algo_balance(), Int(0)),
        InnerTxnBuilder.Submit(),
        # log so can retrieve info for claiming
        Log(Concat(
            MethodSignature("ClaimDelayedMint(byte[36],address,address,uint64,uint64)"),
            box_name,
            minter.get(),
            delay_mint_receiver,
            Itob(delay_mint_stake),
            Itob(mint_amount.load()),
        )),
    )


@router.method(no_op=CallConfig.CALL)
def burn(send_xalgo: abi.AssetTransferTransaction, receiver: abi.Address, min_received: abi.Uint64) -> Expr:
    burn_amount = send_xalgo.get().asset_amount()
    algo_balance = ScratchVar(TealType.uint64)
    algo_to_send = ScratchVar(TealType.uint64)

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check address passed is 32 bytes
        address_length_check(receiver),
        # check xALGO sent
        check_x_algo_sent(send_xalgo),
        # sync before sending the algo as to not offset sent algo against rewards
        sync_proposers_active_balance_and_unclaimed_fees(),
        # calculate algo amount to send before update proposers active balance
        algo_balance.store(App.globalGet(last_proposers_active_balance_key) - App.globalGet(total_unclaimed_fees_key)),
        algo_to_send.store(
            mul_scale(
                burn_amount,
                algo_balance.load(),
                get_x_algo_circulating_supply() + burn_amount
            )
        ),
        # check amount and send ALGO to user
        Assert(algo_to_send.load()),
        Assert(algo_to_send.load() >= min_received.get()),
        send_algo_from_proposers(receiver.get(), algo_to_send.load()),
        # update proposers active balance considering algo sent
        App.globalPut(last_proposers_active_balance_key, App.globalGet(last_proposers_active_balance_key) - algo_to_send.load()),
        # log burn
        Log(Concat(
            MethodSignature("Burn(address,uint64,uint64)"),
            Txn.sender(),
            Itob(burn_amount),
            Itob(algo_to_send.load()),
        )),
    )


@router.method(no_op=CallConfig.CALL)
def get_xalgo_rate(*, output: XAlgoRate) -> Expr:
    algo_balance = abi.Uint64()
    x_algo_circulating_supply = abi.Uint64()
    proposers_balances = abi.DynamicBytes()

    num_proposers = ScratchVar(TealType.uint64)
    i = ScratchVar(TealType.uint64)
    balances = ScratchVar(TealType.bytes)

    return Seq(
        rekey_and_close_to_check(),
        # ensure initialised
        Assert(App.globalGet(initialised_key)),
        # check proposer exists
        Assert(App.globalGet(num_proposers_key)),
        # ensure latest changes
        sync_proposers_active_balance_and_unclaimed_fees(),
        # calculate rate
        algo_balance.set(App.globalGet(last_proposers_active_balance_key) - App.globalGet(total_unclaimed_fees_key)),
        x_algo_circulating_supply.set(get_x_algo_circulating_supply()),
        # set proposers balances array
        num_proposers.store(App.globalGet(num_proposers_key)),
        balances.store(BytesZero(num_proposers.load() * Int(8))),
        For(i.store(Int(0)), i.load() < num_proposers.load(), i.store(i.load() + Int(1))).Do(
            balances.store(Replace(
                balances.load(),
                i.load() * Int(8),
                Itob(get_proposer_balance(i.load(), Int(1)))
            ))
        ),
        proposers_balances.set(balances.load()),
        # return
        output.set(algo_balance, x_algo_circulating_supply, proposers_balances)
    )


# used to append proposer accounts to foreign app array
@router.method(no_op=CallConfig.CALL)
def dummy() -> Expr:
    return Seq()


pragma(compiler_version="0.26.1")
approval_program, clear_program, contract = router.compile_program(
    version=10, optimize=OptimizeOptions(scratch_slots=True)
)

if __name__ == "__main__":
    print(approval_program)
