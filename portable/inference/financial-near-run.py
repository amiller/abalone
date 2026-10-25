#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fixed direct-NEAR consumer under the existing root financial lease supervisor."""
import sys
sys.path.insert(0,'/opt/portable/portable/raspberry-pi/storage')
import financial_lease
financial_lease.ENTRY='/opt/portable/portable/inference/direct-near-entry.mjs'
if __name__=='__main__':
 try:
  if len(sys.argv)!=1:raise ValueError('arguments refused')
  ok=financial_lease.supervise_until_lock(financial_lease.acquire())
 except BaseException:
  print('Inference unavailable',file=sys.stderr);raise SystemExit(1)
 raise SystemExit(0 if ok else 1)
