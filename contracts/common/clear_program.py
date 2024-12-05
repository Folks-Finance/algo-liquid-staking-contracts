import sys
from pyteal import *


def clear_program():
    return Int(1)


if __name__ == "__main__":
    version = int(sys.argv[1])
    print(compileTeal(clear_program(), Mode.Application, version=version))
