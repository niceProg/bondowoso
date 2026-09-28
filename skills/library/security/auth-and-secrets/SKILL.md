---
name: auth-and-secrets
description: Authentication, authorisation and secret handling
tier: library
domains: [backend, api, frontend]
trigger: auth, login, logout, session, token, jwt, password, permission, role, admin, secret, payment, webhook
---
- Authenticate every protected route; authorise per resource and per action.
- Sessions in `httpOnly`, `secure`, `sameSite` cookies; never tokens in localStorage.
- Passwords hashed with a slow algorithm (bcrypt/argon2); constant-time comparisons for
  tokens and signatures; verify webhook signatures before trusting payloads.
- Secrets come from environment/config at runtime. Never commit them, log them, or send them
  to the client.
- Rate-limit authentication and other abusable endpoints.
