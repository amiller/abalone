#!/usr/bin/env python3
"""Score reader outputs against cases: keyword recall of gap_keywords over gap+model+deployed+assumptions+trusted_base,
and a judge verdict on whether the stated gap names the documented one.
Usage: score.py [--judge CMD] OUT_DIR   (no --judge: names_gap is reported MISSING)"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm import ask, parse_json

CASES = Path(__file__).parent / "cases"
p = argparse.ArgumentParser()
p.add_argument("--judge")
p.add_argument("out")
a = p.parse_args()
rows = []
for f in sorted(Path(a.out).glob("*.json")):
    c, r = json.loads((CASES / f.name).read_text()), json.loads(f.read_text())
    text = " ".join([r["gap"], r["model"], r["deployed"], *r["assumptions"], *r["trusted_base"]]).lower()
    recall = sum(k in text for k in c["gap_keywords"]) / len(c["gap_keywords"])
    v = a.judge and parse_json(ask(a.judge, "Does the CANDIDATE gap name the same proof-to-deployment gap as the REFERENCE (it may add more)? "
                   'Reply JSON {"names_gap": true|false} only.\n\nREFERENCE: ' + c["gap"] + "\n\nCANDIDATE: " + r["gap"]))["names_gap"]
    rows.append({"case": c["slug"], "keyword_recall": round(recall, 2), "names_gap": bool(v) if a.judge else "MISSING"})
    print(json.dumps(rows[-1]))
n = len(rows)
print(json.dumps({"cases": n, "keyword_recall": round(sum(r["keyword_recall"] for r in rows) / n, 3), "names_gap": sum(r["names_gap"] for r in rows) if a.judge else "MISSING"}))
