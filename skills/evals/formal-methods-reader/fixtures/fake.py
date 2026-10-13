#!/usr/bin/env python3
"""Offline stand-ins. reader-gold: answers with the case's own gold fields (score ceiling).
reader-naive: says "verified" with no gap. judge: true iff the candidate shares ≥3 words of 6+ letters with the reference."""
import json, re, sys
from pathlib import Path
role, prompt = sys.argv[1], sys.stdin.read()
if role == "judge":
    w = lambda s: set(re.findall(r"[a-z]{6,}", s.lower()))
    ref, cand = prompt.split("REFERENCE: ", 1)[1].split("\n\nCANDIDATE: ")
    print(json.dumps({"names_gap": len(w(ref) & w(cand)) >= 3})); sys.exit()
c = json.loads((Path(__file__).parents[1] / "cases" / (re.search(r"CASE: (\S+)", prompt).group(1) + ".json")).read_text())
if role == "reader-gold":
    print(json.dumps({k: c[k] for k in ["artifact", "tool", "property", "model", "trusted_base", "assumptions", "deployed", "gap"]}))
else:
    print(json.dumps({"artifact": c["artifact"], "tool": c["tool"], "property": c["property"], "model": "the source code",
                      "trusted_base": [], "assumptions": [], "deployed": "same as verified", "gap": "None: the system is formally verified."}))
