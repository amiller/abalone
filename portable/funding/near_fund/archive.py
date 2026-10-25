# SPDX-License-Identifier: MIT
"""Explicit new-demo reset of a completed cycle; unknown cycles never reset."""
import os,stat
from pathlib import Path
import context
NAMES=('account','config.json','attempts','provider-previous.json','activation-intent.json','activation-complete.json')
def closed_cycle(base):
 base=context.private_directory(base)
 if (base/'new-demo-intent.json').exists() or (base/'provider-next.json').exists():raise ValueError('unresolved cycle')
 if context.read(base/'activation-complete.json')!={'state':'funded-and-service-started'}:raise ValueError('cycle not complete')
 for name in NAMES:
  s=(base/name).lstat();expected=stat.S_ISDIR if name in ('account','attempts') else stat.S_ISREG
  if not expected(s.st_mode) or s.st_uid not in (0,os.getuid()) or stat.S_IMODE(s.st_mode)!=(0o700 if name in ('account','attempts') else 0o600):raise ValueError('closed artifact refused')
 prior=base/'prior-account'
 if os.path.lexists(prior):context.private_directory(prior)
 history=base/'history';history.mkdir(mode=0o700,exist_ok=True);context.private_directory(history)
 target=history/os.urandom(16).hex();target.mkdir(mode=0o700);context.syncdir(history)
 context.save(base/'new-demo-intent.json',{'version':1,'archive':target.name,'automaticRetry':False})
 # Rename directory inodes, never copy rotating session tokens. Existing
 # refresh requests retain their admitted directory FD across either rename.
 if os.path.lexists(prior):os.rename(prior,target/'prior-account')
 os.rename(base/'account',prior)
 for name in NAMES:
  if name!='account':os.rename(base/name,target/name)
 context.syncdir(target);context.syncdir(base)
 (base/'attempts').mkdir(mode=0o700);context.syncdir(base)
 os.rename(base/'new-demo-intent.json',target/'new-demo-intent.json');context.syncdir(target);context.syncdir(base)
 return {'archivedCompletedCycle':True,'activeInferenceCredentialChanged':False,'transitSignerChanged':False}
