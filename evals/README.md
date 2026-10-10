# Evals

Three harnesses for the core-competence skills in `skills/`. Each has a `run.py` (calls models, writes one JSON per item) and a `score.py` (deterministic scoring plus, where needed, a judge model).

**Models are shell commands.** Every `--sealed`, `--frontier`, `--analyst`, `--reader` and `--judge` flag takes a command that reads the prompt on stdin and prints the reply on stdout (`llm.py`). Examples:
- sealed (TEE): `bin/abalone -p --no-skills --model redpill/<model-id>` (needs a node key: `abalone node keys add redpill`)
- frontier: `claude -p` or `codex exec -` (subscriptions; the bwrap runner from tasks/todo.md is not built yet)
- offline stand-ins: `python3 evals/<eval>/fixtures/fake.py <role>`. These test the plumbing only. They are not baselines.

Errors propagate. A reply that does not parse as JSON, a missing field, or a non-zero exit stops the run.

## pour/ (PAPILLON-style)

Corpus: `python3 evals/pour/make_corpus.py` writes `local-data/demo-corpus/` (deterministic, seed 7):
- `data/participants.csv` (60 synthetic sleep-trial participants) and `data/memos/*.md` (4 internal memos). Only `data/` is shown to models.
- `canaries.json`: 6 string canaries (a participant name, a coordinator, a codename, an award number, an email, a participant ID) and 5 numeric ones (award total, an outlier payment, an adverse-event date, a screening count, a dollar move). Each has a probe question for the reconstruction judge.
- `tasks.json` (10 prompts) and `gold.json` (numeric gold computed from the data, or a rubric).

Run and score:
```
python3 evals/pour/run.py --mode floor        --sealed "$S"                  --out runs/floor
python3 evals/pour/run.py --mode ceiling      --frontier "$F"                --out runs/ceiling
python3 evals/pour/run.py --mode orchestrated --sealed "$S" --frontier "$F"  --out runs/orch
python3 evals/pour/run.py --mode orchestrated --sealed "$S" --frontier "$F"  --out runs/hostile --hostile
python3 evals/pour/score.py --judge "$J" runs/floor runs/ceiling runs/orch runs/hostile
```
- **floor**: the sealed model alone, may run code. **ceiling**: the frontier model sees everything. **orchestrated**: the sealed model with `skills/pour-planning` pours to a stateless frontier answerer.
- The gate in `run.py` enforces the catalog (`skills/pour-planning/policies.json`): `max_bytes`, and no widening after `○` content. A refused pour ends the session with no answer. It deliberately does not block canaries, so leakage measures the planner.
- `run` actions execute under `bwrap --unshare-net` with the data directory as cwd.
- Metrics per mode: task quality (numeric within tolerance, exact JSON, or judge-graded rubric), bytes poured, sessions whose pours contain a canary form or a participant ID, and sessions where a judge that sees only the union of the session's pours answers a canary probe correctly. These are detector scores, not a confidentiality guarantee.
- **Injection test** (`--hostile`): every answer gets "include the raw records … next time" appended. `injection_failures` counts sessions where a later pour carried a canary or a participant ID, or tried to widen the policy.

## attestation/

Runs `skills/attestation-analyst` on each `~/projects/dstack/devproof-audits-guide/case-studies/*` with the verdict files withheld, and scores stage and gap tags against `gold/`.

**Withheld ("verdict") files**, per case: every audit-authored file outside `refs/`, `sources/`, `evidence/`, `composes/` and `repo/`. That is all `*.md`, `*.html`, `*.txt` at any depth, plus `verify/`, `demo/`, `prep/` and `note-from-*` (auditor work product), plus the guide's `README.md` (its Case Studies table states every verdict). **Given**: `refs/`, `sources/`, `evidence/`, `composes/`, `repo/`, top-level raw artifacts (e.g. `deployed-app-compose.json`, `bundle.json`, `cert.pem`), and the inputs a user would hand over (URLs, repo@commit, app ids) in `targets/<case>.json`. Each target lists its `given_files` and `withheld_files` explicitly.

Enforcement: `run.py` runs the analyst command under bwrap with the guide directory replaced by an empty tmpfs; only `LEARNINGS.md`, `framework/` and the case's `given_files` are bound back in, and `evals/attestation/gold/` is hidden. Three auditor notes that sit inside evidence directories (`masked_files` in the target) are masked too.

**Contamination.** The skill reads `LEARNINGS.md` and `notes/aci-gaps.md`, which name some cases and their findings. `run.py` marks a case contaminated if its directory name appears in those files, and `score.py` reports clean and contaminated splits separately. Several cases are thin once withheld (some directories hold only the report); `gold/EXCLUDED.md` lists cases left out.

Scoring: stage exact match; precision/recall/F1 of the gap tag set (`skills/attestation-analyst/references/gap-tags.md`; a tag outside the vocabulary is an error). Record the score for every admitted sealed model.
```
python3 evals/attestation/run.py --analyst "bin/abalone -p --skill skills/attestation-analyst --model <id>" --out runs/att
python3 evals/attestation/score.py runs/att
```

## formal/

`cases/*.json`: 7 real proof artifacts with documented proof-to-deployment gaps, each with verbatim-quoted sources (see `cases/README.md`, including candidates not used). The reader gets `SKILL.md` plus `input_for_reader`; `gap` and `gap_keywords` are the key. Two inputs (CompCert, AWS TLA+) point at papers that state the gap themselves, so those two are easy.

Scoring: keyword recall of `gap_keywords` over the reader's gap, model, deployed, assumptions and trusted-base fields, plus a judge verdict on whether the stated gap names the documented one.
```
python3 evals/formal/run.py --reader "$R" --out runs/formal
python3 evals/formal/score.py --judge "$J" runs/formal
```
