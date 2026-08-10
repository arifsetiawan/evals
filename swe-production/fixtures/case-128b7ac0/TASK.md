# case-128b7ac0

When a customer places an order through the WhatsApp agent, two things go wrong: their lead stays at NEW_LEAD forever instead of reflecting the sale, and they still receive cold follow-up nudges afterwards as though they never ordered.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: medium
