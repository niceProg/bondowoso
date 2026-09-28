---
name: debugging-systematically
description: Find the root cause of a bug before fixing it
tier: library
domains: [backend, api, frontend, database]
trigger: bug, fix, broken, crash, error, regression, fails, failing, incorrect, not working, hotfix
---
1. Reproduce: find the exact input or steps and the exact wrong output. Capture it as a
   failing test when possible.
2. Localise: follow the data from the entry point to where it first becomes wrong. Read the
   code on that path instead of guessing; use logs and existing tests.
3. Explain: state the root cause in one sentence. If you cannot, you have not found it.
4. Fix the cause, not the symptom. Check the same mistake elsewhere (search for siblings).
5. Prove it: the reproduction now passes and nothing else regressed.
