from pyteal import If, Int, Expr, Subroutine, TealType
from common.utils.muldiv64 import MulDiv64

ONE_4_DP = Int(int(1e4))
ONE_16_DP = Int(int(1e16))

# Multiplication with scale down
# Args:
#   n1 (uint_64 Xdp)
#   n2 (uint_64 Ydp)
#   scale (uint_64 Zdp) - 1eZ
# Returns:
#   uint_64 ((X + Y - Z)dp) - the result of multiplying the two args
@Subroutine(TealType.uint64)
def mul_scale(n1: Expr, n2: Expr, scale: Expr):
    return MulDiv64(n1, n2, scale)

# Minimum of two integers
# Args:
#   n1 (uint_64)
#   n2 (uint_64)
# Returns:
#   uint_64 - the minimum of the two integers
@Subroutine(TealType.uint64)
def minimum(n1: Expr, n2: Expr):
    return If(n1 < n2, n1, n2)
