#!/usr/bin/env python3
"""Offline stand-in analyst that reports what it can see from inside the run.py sandbox, and guesses Stage 0 with one tag.
Used to check that withheld files and gold/ are invisible. Not a baseline."""
import json, re, sys
from pathlib import Path
prompt = sys.stdin.read()
case_dir = Path(re.search(r"EVIDENCE FILES \(under (\S+)\)", prompt).group(1))
guide = case_dir.parent
golds = [Path(__file__).resolve().parents[1] / "gold", Path(__file__).resolve().parent / "gold"]
visible = sorted(str(p.relative_to(guide)) for p in guide.rglob("*") if p.is_file() and "/refs/" not in str(p) and "/repo/" not in str(p))
print(json.dumps({"subject": case_dir.name, "stage": "0", "axes": {}, "gaps": [{"axis": "operator", "tag": "op:no-upgrade-log", "id": None, "text": "guess", "cite": "none"}],
                  "_visible": visible[:50], "_gold_visible": [p.name for gold in golds for p in gold.glob("*")]}))
