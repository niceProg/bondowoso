---
name: iterating-to-completion
description: Work loop for implementing one task until it is verifiably done
tier: core
roles: [developer, simplifier, tester]
---
1. Read before writing: open the files the task touches and one or two neighbours that show
   the local conventions. Search for existing helpers before adding new ones.
2. Make the smallest change that satisfies the acceptance criteria. No drive-by refactors.
3. Verify with the real commands after each meaningful change, not only at the end. Read the
   actual output; a command that exits 0 with warnings you introduced is not done.
4. When something fails, find the cause before changing code again (read the error, the
   stack trace, the failing line). Never retry the same edit hoping for a different result.
5. Stop when every acceptance criterion is met and verified, or when you are blocked. Report
   precisely what you changed and why, or exactly what is missing.
