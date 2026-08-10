# case-22b61812

A lead that runs out of follow-up cadence gets marked LOST. If that customer then places an order and pays for it, the lead stays LOST — it never transitions to WON.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: easy
