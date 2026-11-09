#!/usr/bin/env python3
"""Root-bound a3 only; default invocation prints an offline plan and starts nothing."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sonnet_retained import A3, RetainedProfile, base

if __name__ == '__main__':
    raise SystemExit(base.main(continuation=RetainedProfile(A3)))
