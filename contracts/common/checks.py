from pyteal import abi, Assert, Concat, Expr, Global, Gtxn, Int, Len, Not, OnComplete, Seq, Subroutine, TealType, Txn, TxnObject, TxnType


def rekey_check(txn: TxnObject):
    return Assert(txn.rekey_to() == Global.zero_address())


def close_to_check(txn: TxnObject):
    return Seq(
        Assert(txn.close_remainder_to() == Global.zero_address()),
        Assert(txn.asset_close_to() == Global.zero_address())
    )


@Subroutine(TealType.none)
def rekey_and_close_to_check():
    return Seq(
        rekey_check(Txn),
        close_to_check(Txn),
    )


@Subroutine(TealType.none)
def address_length_check(address: abi.Address):
    return Assert(Len(address.get()) == Int(32))


def user_call_to_add_escrow_check(user_call: abi.PaymentTransaction, note_prefix: Expr):
    return Seq(
        rekey_check(user_call.get()),
        close_to_check(user_call.get()),
        Assert(user_call.get().sender() != Txn.sender()),
        Assert(user_call.get().receiver() == Global.current_application_address()),
        Assert(Not(user_call.get().amount())),  # is zero
        Assert(user_call.get().note() == Concat(note_prefix, Txn.sender()))  # query optimisation
    )


def remove_escrow_check(escrow: abi.Account, note_prefix: Expr):
    return Seq(
        # check opt out of application
        Assert(Gtxn[Txn.group_index() + Int(1)].sender() == escrow.address()),
        Assert(Gtxn[Txn.group_index() + Int(1)].type_enum() == TxnType.ApplicationCall),
        Assert(Gtxn[Txn.group_index() + Int(1)].on_completion() == OnComplete.CloseOut),
        Assert(Gtxn[Txn.group_index() + Int(1)].application_id() == Global.current_application_id()),
        # check close out account
        Assert(Gtxn[Txn.group_index() + Int(2)].sender() == escrow.address()),
        Assert(Gtxn[Txn.group_index() + Int(2)].receiver() == Txn.sender()),
        Assert(Gtxn[Txn.group_index() + Int(2)].type_enum() == TxnType.Payment),
        Assert(Not(Gtxn[Txn.group_index() + Int(2)].amount())),  # is zero
        Assert(Gtxn[Txn.group_index() + Int(2)].close_remainder_to() == Txn.sender()),  # fails if opted into asset
        Assert(Gtxn[Txn.group_index() + Int(2)].note() == Concat(note_prefix, escrow.address()))  # query optimisation
    )
