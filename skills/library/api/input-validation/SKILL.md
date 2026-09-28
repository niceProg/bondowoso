---
name: input-validation
description: Validate and normalise untrusted input at the boundary
tier: library
domains: [api, backend]
trigger: endpoint, route, request, form, input, validation, validate, payload, query param, upload
---
- Validate at the edge (handler or BFF route), before any business logic or database call.
- Allow-list: check type, length, range, format and enum membership; reject unknown fields
  where the framework allows.
- Return 400/422 with field-level messages; never echo raw input back into HTML.
- Parameterised queries only. Never build SQL, shell commands or file paths from input.
- Check authorisation for the specific resource (ownership), not just authentication.
