import json
import os
from pyteal import *

router = Router(
    name="XGovRegistry",
    bare_calls=BareCallActions(
        no_op=OnCompleteAction(
            action=Seq(App.globalPut(Bytes("xgov_fee"), Int(int(100e6))), Approve()),
            call_config=CallConfig.CREATE
        ),
    )
)

@router.method(no_op=CallConfig.CALL)
def subscribe_xgov(voting_address: abi.Address, payment: abi.PaymentTransaction) -> Expr:
    return Approve()


@router.method(no_op=CallConfig.CALL)
def unsubscribe_xgov(xgov_address: abi.Address) -> Expr:
    return Approve()


approval_program, clear_program, contract = router.compile_program(
    version=10, optimize=OptimizeOptions(scratch_slots=True)
)

if __name__ == "__main__":
    with open(os.path.dirname(os.path.abspath(__file__)) + "/xgov_registry.json", "w") as f:
        f.write(json.dumps(contract.dictify(), indent=4))

    print(approval_program)
