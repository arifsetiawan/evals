# case-5bc87524

A bill can get permanently stuck. Void the bill's only payment and the bill correctly returns to OPEN with the full amount outstanding — but the Void action then disappears from the bills drawer, so the bill itself can no longer be voided. That matters because a goods-receipt quantity can only be corrected by voiding and re-creating.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: medium
