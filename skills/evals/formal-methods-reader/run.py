#!/usr/bin/env python3
"""Run formal-methods-reader on each case. The reader sees SKILL.md plus the case's input_for_reader, never the gap.
Usage: run.py --reader CMD --out DIR [--cases slug,...]"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools/eval"))
from llm import ask, parse_json

ROOT = Path(__file__).resolve().parents[3]
CASES = Path(__file__).parent / "cases"

p = argparse.ArgumentParser()
p.add_argument("--reader", required=True, help="model command (stdin → stdout); give it web/file tools if it should fetch the links")
p.add_argument("--out", required=True)
p.add_argument("--cases")
a = p.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
skill = (ROOT / "skills/formal-methods-reader/SKILL.md").read_text()
for f in sorted(CASES.glob("*.json")):
    c = json.loads(f.read_text())
    if a.cases and c["slug"] not in a.cases.split(","):
        continue
    prompt = skill + "\n\nCASE: " + c["slug"] + "\nINPUTS:\n" + "\n".join("- " + s for s in c["input_for_reader"]) + "\n\nReply with the JSON object from the Output section."
    (out / f.name).write_text(json.dumps(parse_json(ask(a.reader, prompt)), indent=1))
    print(c["slug"], file=sys.stderr)
