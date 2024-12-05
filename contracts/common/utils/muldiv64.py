from typing import Iterator
from pyteal import CompileOptions, Expr, Int, Op, TealBlock, TealSimpleBlock
from pyteal.ir.tealop import TealOp
from pyteal.types import TealType, require_type
from .assemble import assemble_steps


class MulDiv64(Expr):
    """
    MulDiv64 calculates the expression (m1 * m2) / d rounded down.
    The result of this operation is a 64 bit integer (the lower 64 bits of the 128 bit result).
    The bounds of the result are checked, and should it exceed the 64 bit integer capacity,
    the runtime will fail.
    """

    def __init__(self, m1: Expr, m2: Expr, d: Expr):
        """Calculate (m1 * m2) / d
        Args:
            m1 (TealType.uint64): factor
            m2 (TealType.uint64): factor
            d (TealType.uint64): divisor
        """
        super().__init__()
        # make sure that argument expressions have the correct return type
        require_type(m1, TealType.uint64)
        require_type(m2, TealType.uint64)
        require_type(d, TealType.uint64)
        self.m1 = m1
        self.m2 = m2
        self.d = d

    def _get_steps(self) -> Iterator[Expr or TealOp]:
        yield self.m1
        yield self.m2
        # multiply args and return result as two uint64
        yield TealOp(self, Op.mulw)
        yield self.d
        # divide uint64, uint64 by uint64 and return result as one uint64
        yield TealOp(self, Op.divw)

    def __teal__(self, options: CompileOptions) -> tuple[TealBlock, TealSimpleBlock]:
        return assemble_steps(self._get_steps(), options)

    def __str__(self):
        return f"(MulDiv64 {self.m1} {self.m2} {self.d})"

    def type_of(self):
        return TealType.uint64

    def has_return(self):
        return False
