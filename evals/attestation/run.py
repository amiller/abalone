#!/usr/bin/env python3
"""Run attestation-analyst against an explicitly selected evidence corpus.
The default is a bundled synthetic plumbing case, not a model-quality baseline.
The bwrap harness hides the corpus and gold, then exposes only given evidence.
Historical targets require --corpus and --targets; no maintainer path is assumed.
Usage: run.py --analyst CMD --out DIR [--corpus DIR --targets DIR] [--cases a,b] [--inline N]
"""
import argparse, json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm import parse_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORPUS = HERE / "fixtures/corpus"
GOLD = HERE / "fixtures/gold"
WITHHOLD = CORPUS
SKILL = ROOT / "skills/attestation-analyst"

def contaminated(case):
    """Cases whose name appears in reference material the skill reads."""
    refs = "\n".join(p.read_text() for p in sorted((SKILL / "references").glob("*.md")))
    return case in refs

def sandbox(t):
    case_dir = CORPUS / t["case"]
    args = ["bwrap", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", str(WITHHOLD), "--tmpfs", str(HERE / "gold"), "--tmpfs", str(HERE / "fixtures/gold"), "--tmpfs", str(GOLD)]
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
            sorted((SKILL / "references").glob("*.md")))
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
    p.add_argument("--corpus", type=Path, default=HERE / "fixtures/corpus", help="case directories containing reviewed evidence")
    p.add_argument("--targets", type=Path, default=HERE / "fixtures/targets", help="target definitions; use attestation/targets for historical cases")
    p.add_argument("--gold", type=Path, default=HERE / "fixtures/gold", help="scoring directory to hide from the analyst")
    p.add_argument("--withhold-root", type=Path, help="hide the entire external guide/corpus tree, including sibling verdicts")
    a = p.parse_args()
    global CORPUS, GOLD, WITHHOLD
    CORPUS, GOLD = a.corpus.resolve(), a.gold.resolve()
    if not CORPUS.is_dir() or not a.targets.is_dir() or not GOLD.is_dir():
        p.error("Use existing corpus, targets and gold directories; historical evidence is not bundled.")
    if CORPUS in (ROOT, HERE) or ROOT.is_relative_to(CORPUS):
        p.error("The corpus must be a dedicated evidence directory, not the repository or its parent.")
    if not CORPUS.is_relative_to(ROOT) and a.withhold_root is None:
        p.error("External corpora require --withhold-root for the entire guide, including sibling verdicts.")
    WITHHOLD = a.withhold_root.resolve() if a.withhold_root else CORPUS
    if not WITHHOLD.is_dir() or not CORPUS.is_relative_to(WITHHOLD) or ROOT.is_relative_to(WITHHOLD):
        p.error("The withholding root must contain the corpus and must not hide the repository.")
    targets = []
    for f in sorted(a.targets.glob("*.json")):
        t = json.loads(f.read_text())
        if a.cases and t["case"] not in a.cases.split(","):
            continue
        case_dir = CORPUS / t["case"]
        if case_dir.parent != CORPUS or not case_dir.is_dir() or case_dir.is_symlink() or not case_dir.resolve().is_relative_to(CORPUS):
            p.error(f"Missing bounded case directory: {t['case']}")
        for given in [*t["given_files"], *t.get("masked_files", [])]:
            item = case_dir / given
            if not isinstance(given, str) or Path(given).is_absolute() or ".." in Path(given).parts:
                p.error(f"Out-of-case evidence in {t['case']}")
            if not item.exists() or not item.resolve().is_relative_to(case_dir.resolve()):
                p.error(f"Missing or out-of-case evidence in {t['case']}: {given}")
            if item.is_dir():
                for child in item.rglob("*"):
                    if child.is_symlink() and not child.resolve().is_relative_to(case_dir.resolve()):
                        p.error(f"Out-of-case evidence symlink in {t['case']}")
        targets.append((f, t))
    if not targets:
        p.error("No selected target definitions.")
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for f, t in targets:
        case_dir = CORPUS / t["case"]
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
