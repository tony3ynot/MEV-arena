"""MEV Arena simulation engine.

Pure domain logic: AMM math, mempool rules, block building, deterministic execution.
This package must stay free of I/O and framework dependencies so that replay
can be verified in isolation.
"""
