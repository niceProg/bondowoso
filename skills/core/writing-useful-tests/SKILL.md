---
name: writing-useful-tests
description: What makes a test worth keeping
tier: core
roles: [tester, reviewer]
---
- One behaviour per test, named after the behaviour ("rejects expired token"), not the
  method.
- Arrange / act / assert, with the assert checking an observable outcome: return value,
  persisted state, emitted response, rendered text. Not private calls or internal fields.
- Mock only what crosses a process boundary (network, database, clock, filesystem, random).
  Prefer the repository's existing fakes and fixtures.
- Cover the edge that would hurt in production: empty input, boundaries, unauthorised
  access, duplicate submissions, time zones, error responses.
- A test must fail when the behaviour breaks. Check it mentally or by temporarily breaking
  the code; a test that cannot fail is noise.
- Keep tests deterministic: no sleeps, no dependence on execution order or wall-clock time.
