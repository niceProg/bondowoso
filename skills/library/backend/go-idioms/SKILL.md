---
name: go-idioms
description: Conventions for Go services (errors, context, packages, tests)
tier: library
domains: [backend, api, database]
trigger: go, golang, .go, gin, gorm, goroutine, handler, go test
---
- Return errors as the last value and wrap with `fmt.Errorf("doing x: %w", err)`; compare
  with `errors.Is/As`, never string matching.
- Pass `context.Context` as the first parameter through every call that does I/O, and respect
  cancellation. Do not store contexts in structs.
- Keep handlers thin: parse and validate input, call a service, map the result to a response.
- Accept interfaces, return concrete types; define interfaces where they are consumed.
- Table-driven tests with `t.Run(name, ...)`; use `t.Helper()` in helpers, `t.Cleanup` for
  teardown. No global mutable state between tests.
- Run `gofmt` and `go vet` before finishing; unused imports and variables fail the build.
