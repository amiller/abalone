# Formal-methods-reader eval cases

Each `<slug>.json` holds one real proof artifact with a documented gap between what was verified and what ran. Every quote in `sources` was checked verbatim (whitespace-normalized) against the fetched page on 2026-10-08. `input_for_reader` is what the skill gets; `gap` and `gap_keywords` are the scoring key.

| slug | tool | gap |
|---|---|---|
| compcert-csmith-frontend | Coq | Csmith's wrong-code bugs in CompCert 1.6 were in the unverified front-end and an under-specified PPC semantics that deferred to the assembler; none in the verified passes. |
| sel4-verified-configurations | Isabelle/HOL | Proofs hold only for listed `*_verified.cmake` configs; DMA off/trusted, boot code and assembly assumed; IOMMU/SMMU, debug interfaces, multicore unverified; AArch64 has no binary-correctness proof. |
| verdi-raft-shim | Coq + OCaml extraction | Fonseca et al. found no protocol bugs, but Verdi's unverified shim assumed whole-message `recv` and crash-atomic disk writes. |
| aws-tla-design-not-code | TLA+ / TLC | Model checks a bounded design spec; AWS says it cannot check that production code implements the design. |
| eth2-deposit-solidity-kevm | K / KEVM | Guarantee is stated for solc 0.6.8 output; mainnet was compiled with solc 0.6.11. Byte comparison (done here) shows identical code apart from CBOR metadata. Scope is one transaction with well-formed calldata. |
| eth2-deposit-vyper-not-deployed | K / KEVM | Bytecode-level proof caught Vyper compiler bugs that a source-level proof would miss, but holds only for one hotfix compiler build, and the verified Vyper contract was never deployed (replaced by Solidity). |
| libcrux-mldsa-aarch64-fallback | hax / F* | Wrong ML-DSA output on Alpine/musl aarch64 came from an unverified fallback for a platform intrinsic, outside the verified modules. |

## Not used

- **Vyper 0.2.15–0.3.0 `@nonreentrant` bug / Curve, July 2023** (https://hackmd.io/@vyperlang/HJUgNMhs2). The postmortem is real, but no formal proof of the affected pools was involved, so there is no verified artifact to compare against. It fits a compiler-trust case, not a proof-gap case.
- **Certora-verified protocol later exploited.** The only hit was an anonymized blog post (tryethernal.com, "23 properties verified", $8M flash loan) with no named protocol or primary postmortem. Not citable.
- **HACL\* in NSS/Firefox.** Cryspen's post links HACL\* PR #797 (endianness bug in C stubs on AIX) and PR #495 (a bug in the high-level spec) and could make a case. Left out because libcrux was better documented with a deployed reproduction.
- **IronFleet, Chapar** are covered in the same Fonseca et al. paper as Verdi; only Verdi was made into a case.
- Not researched for lack of time: s2n-tls SAW, AWS Zelkova, Intel TDX / dstack, Tezos Mi-Cho-Coq, zk-circuit verifier mismatches, Coq/Lean extraction gaps outside Verdi.
