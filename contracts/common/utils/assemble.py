from typing import Iterable
from pyteal import CompileOptions, Expr, TealBlock, TealOp, TealSimpleBlock


def assemble_steps(steps: Iterable[TealOp or Expr], options: CompileOptions) -> tuple[TealBlock, TealSimpleBlock]:
    """
    Assemble steps that are either expressions or TEALOps into a sequence of blocks
    """
    start = None
    end = None
    for i, step in enumerate(steps):
        if isinstance(step, Expr):
            argStart, argEnd = step.__teal__(options)
        else:
            argStart, argEnd = TealBlock.FromOp(options, step)
        if i == 0:
            start = argStart
            end = argEnd
        else:
            end.setNextBlock(argStart)
            end = argEnd

    return start, end
