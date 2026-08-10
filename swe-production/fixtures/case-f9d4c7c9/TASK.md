# case-f9d4c7c9

Creating a sales order with a 100% discount fails. The order total comes to zero and invoice creation is rejected by validation instead of succeeding. This needs to work for promos, free tier, and zero-value POS credit sales.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: medium
