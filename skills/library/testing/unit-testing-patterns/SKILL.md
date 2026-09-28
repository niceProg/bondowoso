---
name: unit-testing-patterns
description: Structuring unit and integration tests in the repository's style
tier: library
domains: [testing, backend, frontend]
trigger: test, tests, testing, unit test, integration test, coverage, spec, vitest, jest, go test
---
- Find and follow the existing test layout, naming and helpers before writing new tests.
- Table-driven or parameterised tests for many input/output pairs.
- Integration tests use real components inside the process (database in a container or
  transaction, HTTP via an in-memory server) and fakes only at external boundaries.
- Test names describe behaviour and the expected outcome.
- Keep fixtures small and local to the test; build test data with helpers, not copy-paste.
