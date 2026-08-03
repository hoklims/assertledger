# Research basis

TestForge's evidence model follows several established testing and provenance principles.

- Mutation testing distinguishes killed mutants from live mutants and reveals oracle weakness that
  coverage alone cannot show: [PIT](https://pitest.org/) and
  [Just et al., FSE 2014](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html).
- Repetition measures observed flakiness; a successful retry does not erase a contradictory run:
  [Gruber et al., 2021](https://arxiv.org/abs/2101.09077) and
  [Lam et al., ISSTA 2019](https://www.microsoft.com/en-us/research/publication/root-causing-flaky-tests-in-a-large-scale-industrial-setting/).
- Selection is stated only over executed evidence; “safe” regression-test selection requires stronger
  assumptions: [Rothermel and Harrold, IEEE TSE 1998](https://digitalcommons.unl.edu/csearticles/11/).
- The manifest separates external parameters, resolved inputs, builder identity, and byproducts,
  inspired by [SLSA build provenance v1.2](https://slsa.dev/spec/v1.2/build-provenance). TestForge does
  not claim a SLSA level.

These sources motivate the design; they do not turn mutant detection into a proof of correctness.
