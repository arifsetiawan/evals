# case-bc3aefd5

Two concurrent bank-statement checks can each read an old reconciliation snapshot, so an older cutoff sometimes overwrites a newer closing balance if it commits last. Fix it.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: easy
