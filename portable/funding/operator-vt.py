#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Root-owned fixed tty4 funding menu. Never a terminal-agent command channel."""
import importlib.util,os,resource,signal,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def main():
 if os.getresuid()!=(0,0,0):raise ValueError('root operator required')
 resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 op=load('funding_tty',HERE.parent/'raspberry-pi/storage/operator-vt.py');op.TTY_MINOR=4;op.EXPECTED_VT=4;op.validate_terminal()
 runner=load('funding_runner',HERE/'operator.py')
 def interrupted(*_):raise KeyboardInterrupt()
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 while True:
  op.wait_for_active_vt(0,expected=4)
  print('\nDsmack funding\nUnlock storage first with Ctrl+Alt+F2.\nF: fund fresh NEAR credit / resume this attempt\nN: new demo after a completed cycle\nS: status    Ctrl+Alt+F1: desktop\nFunding uses the saved Base transit wallet; it is not a new anonymous Base wallet.\nChoice: ',end='',flush=True)
  choice=op.read_line_echo(0).lower();op.require_active_vt(0,expected=4)
  if choice not in (b'f',b's',b'n'):continue
  try:
   result=runner.run({b'f':'fund',b's':'status',b'n':'new-demo'}[choice])
   print('Funding complete; return to the desktop.' if result.get('state')=='funded-and-service-started' else 'Status received. No replacement attempt was created.',flush=True)
  except KeyboardInterrupt:print('\nStopped. The same attempt is retained; use Status before continuing.',flush=True)
  except Exception:print('\nOperation stopped or outcome unknown. The same attempt is retained; no automatic replacement.',flush=True)
if __name__=='__main__':main()
