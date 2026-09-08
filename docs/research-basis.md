# Research basis

AssertLedger's evidence model follows several established testing and provenance principles.

- Mutation testing distinguishes killed mutants from live mutants and reveals oracle weakness that
  coverage alone cannot show: [PIT](https://pitest.org/) and
  [Just et al., FSE 2014](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html).
- Repetition measures observed flakiness; a successful retry does not erase a contradictory run:
  [Gruber et al., 2021](https://arxiv.org/abs/2101.09077) and
  [Lam et al., ISSTA 2019](https://www.microsoft.com/en-us/research/publication/root-causing-flaky-tests-in-a-large-scale-industrial-setting/).
- Selection is stated only over executed evidence; “safe” regression-test selection requires stronger
  assumptions: [Rothermel and Harrold, IEEE TSE 1998](https://digitalcommons.unl.edu/csearticles/11/).
- The manifest separates external parameters, resolved inputs, builder identity, and byproducts,
  inspired by [SLSA build provenance v1.2](https://slsa.dev/spec/v1.2/build-provenance). AssertLedger does
  not claim a SLSA level.
- The proposed Agentic Test Profile keeps evidence strength and observed execution cost as separate
  dimensions. This follows cost-aware regression-test prioritization rather than treating line
  coverage as an oracle-quality score: [Elbaum, Rothermel, and Penix, FSE
  2014](https://research.google/pubs/techniques-for-improving-regression-testing-in-continuous-integration-development-environments/)
  and [Meta predictive test
  selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/).
- Mutation-guided agentic testing now has industrial hardening and catching-test evidence. The two
  modes have different reference directions and must remain distinct: [Mutation-Guided LLM-based
  Test Generation at Meta](https://arxiv.org/abs/2501.12862) and [Just-in-Time Catching Test
  Generation at Meta](https://arxiv.org/abs/2601.22832).

These sources motivate the design; they do not turn mutant detection into a proof of correctness.
