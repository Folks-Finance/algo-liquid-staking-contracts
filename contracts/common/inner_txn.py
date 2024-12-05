from pyteal import Expr, If, InnerTxnBuilder, Int, Seq, Subroutine, TealType, TxnField, TxnType


# Transfer algo or asset using inner transaction
@Subroutine(TealType.none)
def get_transfer_inner_txn(sender: Expr, receiver: Expr, amount: Expr, asset_id: Expr):
    return Seq(
        InnerTxnBuilder.SetFields({
            TxnField.sender: sender,
            TxnField.fee: Int(0),
        }),
        If(
            asset_id,
            InnerTxnBuilder.SetFields({
                TxnField.type_enum: TxnType.AssetTransfer,
                TxnField.xfer_asset: asset_id,
                TxnField.asset_amount: amount,
                TxnField.asset_receiver: receiver,
            }),
            InnerTxnBuilder.SetFields({
                TxnField.type_enum: TxnType.Payment,
                TxnField.amount: amount,
                TxnField.receiver: receiver,
            }),
        ),
    )
