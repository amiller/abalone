---
name: formal-methods-reader
description: Read a formal proof artifact (Lean, Coq/Rocq, Isabelle, Dafny, Verus, F*, K, TLA+, Certora, SAW, Kani) and state the property proven, the model it is proven over, the trusted base and assumptions, and the gap between the verified artifact and what is deployed. Use when a service, contract or library cites a proof or "formal verification" as evidence of trustworthiness.
---

# Formal methods reader

A proof is a statement about a model, relative to a trusted base. The question for a user is whether the thing they talk to is that model. Your output answers four questions and never collapses them into "verified ✓".

## Procedure

1. **Find the top-level theorem.** Locate the statement that the artifact's claims rest on (the `theorem`/`lemma` in Coq, Lean, Isabelle; `ensures` on the entry point in Dafny/Verus; `rule`/`invariant` in Certora CVL; the `claim` in K; the `THEOREM` / `Spec => []Inv` in TLA+). Quote it. If the project's README claims more than the theorem says, record both.

2. **Property.** Restate the theorem in one plain sentence: safety, functional correctness against a spec, refinement, noninterference, liveness, absence of a bug class. Say which. A proof of "no overflow" is not a proof of "correct". A proof of an invariant on some rules is not about the rules it omits.

3. **Model.** What is the proof over?
   - Source, IR, or binary? (e.g. C source vs compiled binary; Solidity vs EVM bytecode; a TLA+ abstraction of a protocol vs its implementation)
   - Which configuration, platform, compiler version and flags?
   - Which components are inside the model and which are modelled by axioms or stubs?

4. **Trusted base and assumptions.** List what must hold for the theorem to mean anything:
   - the prover kernel and any extraction or code generation step;
   - the spec itself (is it the property people care about?);
   - axioms, `admit`/`sorry`/`assume`/`{:axiom}`/`#[verifier::external]`, havoc'd or summarized calls; grep for them and count them;
   - the compiler and linker if the proof is at source level;
   - hardware, firmware, boot code, and the environment (network, OS, other contracts);
   - bounds (Kani/CBMC unwinding, TLC model size, Certora loop unrolling).

5. **Gap to deployment.** Compare the verified artifact with the deployed measurement:
   - Is the deployed binary or bytecode the output of the verified source, built with the verified toolchain and configuration? Trace it the way `attestation-analyst` traces compose → image → commit.
   - Was the deployed version the verified version, or a later one? Name the exact build of each side: source language and commit or release, compiler or toolchain version, build variant (e.g. a hotfix branch) and configuration. Two artifacts match only if you can cite both identifiers or a byte comparison. Never write "the deployment runs the same bytecode/binary" from memory or from the project's own claims; if one side's identifier is not in your inputs, the gap names that identifier as missing.
   - Are the unverified parts (parsers, glue, assembly, upgrade proxies, oracles, admin keys, the compiler) on the path the user's data or funds take?
   - Did the verified configuration match the deployed one (e.g. IOMMU on, specific platform, optimizer setting)?
   Name the gap concretely: "the proof covers X; the deployment runs Y; Y differs from X in Z". If you cannot find the deployed measurement, the gap is "deployment not traced" and say what is missing.

## Output

```json
{
  "artifact": "repo/path@commit or paper",
  "tool": "Coq | Isabelle | ...",
  "theorem": "quoted statement, with file:line",
  "property": "one sentence",
  "model": "what the proof is over: level, configuration, version",
  "trusted_base": ["..."],
  "assumptions": ["axioms/admits/bounds, with counts and file:line"],
  "deployed": "what actually runs, with its measurement if known",
  "gap": "the proof-to-deployment gap in one or two sentences",
  "cites": ["file:line or URL for each claim above"]
}
```

Then one line for the `assurance` axis in attestation-analyst form, e.g. `proof: functional correctness of the C kernel on ARMv7 verified config; deployed on x86 unverified config → partial`.
