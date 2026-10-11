#!/usr/bin/env python3
"""Score analyst profiles against gold: stage match and gap-tag precision/recall/F1 (tag sets), split by contamination.
Usage: score.py OUT_DIR"""
import argparse, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TAGS = set(re.findall(r"^\| `([a-z]+:[a-z-]+)`", (HERE.parents[1] / "skills/attestation-analyst/references/gap-tags.md").read_text(), re.M))
parser = argparse.ArgumentParser()
parser.add_argument("out", type=Path)
parser.add_argument("--gold", type=Path, default=HERE / "fixtures/gold")
args = parser.parse_args()
rows = []
for f in sorted(args.out.glob("*.json")):
    prof, gold = json.loads(f.read_text()), json.loads((args.gold / f.name).read_text())
    got, want = {g["tag"] for g in prof["gaps"]}, {g["tag"] for g in gold["gaps"]}
    bad = got - TAGS
    if bad:
        raise ValueError(f"{f.name}: tags not in vocabulary: {bad}")
    tp = len(got & want)
    pr, rc = (tp / len(got) if got else float(not want)), (tp / len(want) if want else float(not got))
    rows.append({"case": f.stem, "stage": prof["stage"], "gold_stage": gold["stage"], "stage_match": None if gold["stage"] is None else prof["stage"] == gold["stage"],
                 "precision": round(pr, 2), "recall": round(rc, 2), "f1": round(2 * pr * rc / (pr + rc), 2) if pr + rc else 0.0,
                 "missed": sorted(want - got), "extra": sorted(got - want), "contaminated": prof["_contaminated"]})
    print(json.dumps(rows[-1]))
for name, rs in [("all", rows), ("clean", [r for r in rows if not r["contaminated"]]), ("contaminated", [r for r in rows if r["contaminated"]])]:
    if rs:
        n = len(rs)
        print(json.dumps({"split": name, "cases": n, "stage_acc": round(sum(r["stage_match"] for r in rs if r["stage_match"] is not None) / sum(r["stage_match"] is not None for r in rs), 3),
                          **{k: round(sum(r[k] for r in rs) / n, 3) for k in ["precision", "recall", "f1"]}}))
