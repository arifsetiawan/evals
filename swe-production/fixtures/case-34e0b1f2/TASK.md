# case-34e0b1f2

A POS user whose role grants fnb-service.waiter-terminals is rejected when calling /api/v2/waiter/* endpoints. Users with that permission should be allowed through. All other cross-app token use must stay rejected.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: easy
