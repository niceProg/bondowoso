Shell permissions. Every Bash command runs under an allowlist; anything else is denied
automatically. Besides simple read-only commands, you may run:
{{allowed_bash}}
- Run one plain command at a time. `cd <dir> && <allowed command>` is fine; pipes into
  other programs, `;` chains and `$(...)` substitutions usually get denied.
- If a command you need is denied, do not look for workarounds through other programs
  (python, node, find -delete, ...). Finish everything else, then report exactly what is
  missing in `blocked_reason` so a human can grant it.
- Secret files (.env, private keys, credentials) and commands that print secrets or push are
  blocked by hooks. Use example values, never real ones.
- When a tool call is denied because your context is nearly full, stop immediately and return
  your structured output (use "blocked" and describe what is left if you are not done); your
  changes are kept for the next agent.
