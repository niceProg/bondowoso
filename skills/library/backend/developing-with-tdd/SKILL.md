---
name: developing-with-tdd
description: Red-green-refactor for logic with clear inputs and outputs
tier: library
domains: [backend, api, database]
trigger: tdd, test first, red green, logic, calculation, parser, validation rule, business rule
---
1. Write the smallest failing test that expresses the next piece of required behaviour. Run
   it and confirm it fails for the expected reason.
2. Write the simplest code that makes it pass. Run the whole relevant suite.
3. Refactor code and test for clarity while staying green.
4. Repeat per acceptance criterion. Edge cases (empty, zero, maximum, invalid) each get a
   test before their handling code.
Skip TDD for pure wiring or styling; do not write tests after the fact that merely mirror
the implementation.
