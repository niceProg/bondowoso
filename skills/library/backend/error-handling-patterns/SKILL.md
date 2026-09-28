---
name: error-handling-patterns
description: Handle, wrap and surface errors consistently
tier: library
domains: [backend, api]
trigger: error handling, errors, retry, timeout, failure, exception, panic, fallback, webhook, external api
---
- Handle an error once: either recover, or wrap it with context and return it. Never both
  log and return the same error.
- Wrap with what was being attempted ("fetch invoice 42: %w"), keep the original cause.
- Map internal errors to user-facing responses at the boundary only; never leak stack
  traces, SQL or secrets to clients.
- Calls to external services need a timeout; retries need a limit and backoff and must be
  safe to repeat (idempotent).
- Do not swallow errors silently. An intentionally ignored error gets a comment saying why.
