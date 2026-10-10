#!/usr/bin/env python3
"""Run attestation-analyst on each devproof case study with the verdict files withheld.
The model command runs under bwrap with the guide directory replaced by an empty tmpfs; only LEARNINGS.md, framework/
and the case's given_files (targets/<case>.json) are bound back in at their real paths, and this eval's gold/ is hidden.
The model command needs file-reading tools (e.g. bin/abalone -p --skill skills/attestation-analyst ...), unless --inline N:
then the prompt carries the reference docs, the given-file listing (no .git/), and up to N bytes of the given files most
likely to matter (compose, Dockerfile, top-level README and *.json/*.yaml, by path depth), for a model with no tools.
Usage: run.py --analyst CMD --out DIR [--cases a,b] [--inline N]"""
import argparse, json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm import parse_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GUIDE = Path.home() / "projects/dstack/devproof-audits-guide"
SKILL = ROOT / "skills/attestation-analyst"

def contaminated(case):
    """Cases whose name appears in reference material the skill reads."""
    refs = (GUIDE / "LEARNINGS.md").read_text() + (ROOT / "notes/aci-gaps.md").read_text() + (GUIDE / "framework/STAGE-1-CHECKLIST.md").read_text()
    return case in refs

def sandbox(t):
    case_dir = GUIDE / "case-studies" / t["case"]
    args = ["bwrap", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", str(GUIDE),
            "--ro-bind", str(GUIDE / "LEARNINGS.md"), str(GUIDE / "LEARNINGS.md"),
            "--ro-bind", str(GUIDE / "framework"), str(GUIDE / "framework"), "--tmpfs", str(HERE / "gold")]
    for g in t["given_files"]:
        args += ["--ro-bind", str(case_dir / g), str(case_dir / g)]
    for m in t.get("masked_files", []):  # auditor notes that sit inside an evidence directory
        args += ["--tmpfs", str(case_dir / m)] if (case_dir / m).is_dir() else ["--ro-bind", "/dev/null", str(case_dir / m)]
    return args

KEY = re.compile(r"(compose|dockerfile|readme|attest|tcb|measure|manifest|\.json$|\.ya?ml$|\.pem$|\.toml$)", re.I)

def inline(t, case_dir, budget):
    files = [f for g in t["given_files"] for f in ([case_dir / g] if (case_dir / g).is_file() else sorted((case_dir / g).rglob("*")))
             if f.is_file() and ".git" not in f.relative_to(case_dir).parts and str(f.relative_to(case_dir)) not in t.get("masked_files", [])
             and not any(str(f.relative_to(case_dir)).startswith(m + "/") for m in t.get("masked_files", []))]
    rel = [str(f.relative_to(case_dir)) for f in files]
    text = "\n\nREFERENCE DOCS (inlined; you have no tools):\n" + "".join(f"\n=== {p} ===\n{p.read_text()}" for p in
            [GUIDE / "LEARNINGS.md", GUIDE / "framework/STAGE-1-CHECKLIST.md", ROOT / "notes/aci-gaps.md"])
    text += f"\n\nGIVEN FILE LISTING ({len(rel)} files, first 400):\n" + "\n".join(rel[:400])
    shown = []
    for f in sorted((f for f in files if KEY.search(f.name)), key=lambda f: len(f.relative_to(case_dir).parts)):
        try:
            body = f.read_text()
        except UnicodeDecodeError:
            continue
        if len(body.encode()) <= budget:
            budget -= len(body.encode()); shown.append(f"\n=== {f.relative_to(case_dir)} ===\n{body}")
    return text + f"\n\nGIVEN FILE CONTENTS ({len(shown)} of {len(rel)} files shown; the rest are listed only):" + "".join(shown)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--analyst", required=True, help="model command (stdin → stdout), with file tools")
    p.add_argument("--out", required=True)
    p.add_argument("--cases")
    p.add_argument("--inline", type=int)
    a = p.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for f in sorted((HERE / "targets").glob("*.json")):
        t = json.loads(f.read_text())
        if a.cases and t["case"] not in a.cases.split(","):
            continue
        case_dir = GUIDE / "case-studies" / t["case"]
        prompt = ((SKILL / "SKILL.md").read_text() + "\n\nreferences/gap-tags.md:\n" + (SKILL / "references/gap-tags.md").read_text() +
                  f"\n\nSUBJECT: {t['subject']}\nINPUTS: {json.dumps(t['inputs'])}\nEVIDENCE FILES (under {case_dir}): {json.dumps(t['given_files'])}\n"
                  "Do not fetch anything over the network. Reply with the JSON profile only.") + (inline(t, case_dir, a.inline) if a.inline else "")
        r = subprocess.run(sandbox(t) + ["bash", "-c", a.analyst], input=prompt, capture_output=True, text=True, check=True, timeout=3600)
        prof = parse_json(r.stdout)
        prof["_contaminated"] = contaminated(t["case"])
        (out / f.name).write_text(json.dumps(prof, indent=1, ensure_ascii=False))
        print(t["case"], prof["stage"], len(prof["gaps"]), file=sys.stderr)

if __name__ == "__main__":
    main()
