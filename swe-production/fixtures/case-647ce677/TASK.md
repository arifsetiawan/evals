# case-647ce677

The AI-drafted cold follow-up nudge is vague. In a conversation clearly about a specific product, the draft says something like "tell me what you were looking for" instead of naming the product. It reads as though the AI forgot something the conversation plainly contains.

## How this fixture was made

Derived from a real bugfix commit in a private repository. The source is at its
pre-fix state; the tests describe the fixed behavior and fail until the bug is
repaired. Customer names, document numbers, identifiers and incident notes were
removed mechanically (`harness/sanitize.mjs`), and the fixture is not written at
all if any denied term survives that pass.

Category: bugfix · Difficulty: easy
