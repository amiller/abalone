#!/usr/bin/python3
"""Fixed root entry; deliberately no consumer, path or account arguments."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from financial_lease import acquire, supervise

if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise ValueError('arguments refused')
        ok = supervise(acquire())
    except BaseException:
        # Never print exception text: custody errors must not disclose records.
        print('financial service unavailable', file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0 if ok else 1)
