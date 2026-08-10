# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this repo is

A collection of evaluations of AI systems — agent behavior, model comparison, retrieval. One
folder per eval, each self-contained and reproducible by a stranger.

**[`METHODS.md`](METHODS.md) is the reference for how evaluations here are designed.** The rules
below are the operating subset; METHODS.md carries the full set with the reasoning. Read it before
designing a new eval or changing how an existing one scores.

**This repo is intended to be public.** Everything in it is written for a reader who has no
context, no access to any private system, and no reason to take a claim on trust.

---

## Rule 1 — The publishability gate (hard rule)

The line is **confidential information and assigned work product** on one side, and **general
skills, methods, and professional judgment** on the other.

The second is the author's, permanently and without qualification. Expertise in evaluating agents
was built partly on employer time; that does not make it employer property, and it is expected to
transfer to whatever comes next. Any rule that says otherwise is wrong — it would mean nobody
could ever change jobs.

**Never enters this repo:**

- Files copied from a private repo — including one the author wrote, if it was created as work
  product. Renaming the variables does not change what it is
- Non-public data of any kind: customer traffic, usage figures, internal metrics, real fixtures
- Internal identifiers: product codenames, cluster names, agent ids, image tags, endpoints, ticket
  numbers
- Unreleased roadmap, unannounced capabilities, internal architecture that isn't publicly
  documented
- Any customer name, and any real credential
- Pricing, margin, and revenue data from the author's own companies — commercially sensitive even
  where there is no employer involved

**Freely usable:**

- Techniques and experimental designs the author knows how to build, re-implemented from scratch
  against public or synthesized data
- General findings about how models and agents behave, stated without reference to any private
  system
- Public tools, public corpora, public documentation, published benchmarks
- Professional judgment about what makes an evaluation sound — which is the entire content of the
  rest of this file

**The test is not "would I know this without the job."** It's: *does this disclose something
non-public about an employer, its customers, or its products?* If no, proceed. If yes, it does not
go in — regardless of how it's phrased or how thoroughly it's sanitized.

Two standing caveats: employment is **concurrent**, not past, so the confidentiality obligation is
live rather than residual; and the author's actual employment and IP-assignment agreement governs,
not this file.

**When a specific item is genuinely unclear, stop and surface it.** Do not resolve a
publishability question by reasoning your way to a comfortable answer.

## Rule 2 — Every eval carries a negative control

A result that only shows the system passing proves nothing. Somewhere in each eval there must be a
case that **should fail, and does**: a deliberately broken input, an unsolvable task, a decoy the
system must not report.

Without it, a green run is indistinguishable from a harness that cannot go red.

## Rule 3 — Freeze the data, and say why

Two systems are only comparable when they run against identical inputs. Pin the commit, snapshot
the fixture, record the version. State this in the README — the reason is part of the method, not
a footnote.

An eval against live or moving data cannot attribute a score change to the thing that changed.

## Rule 4 — Deterministic scoring wherever it is possible

Prefer a test that runs, an exact-match check, or a string assertion over a model's judgment. When
an LLM judge is genuinely required, say so, pin the judge model and prompt, and treat the judge as
a variable that itself needs validation.

Variance in the result should be variance in the system under test, never in the scorer.

## Rule 5 — Multiple runs, and report the spread

Single-run numbers presented as stable are the most common failure mode in published evals.
Minimum three trials per condition. Report the range, not just the mean. **Instability is often
the more interesting finding than the average.**

## Rule 6 — Findings, not scores

A pass rate is not a result. The deliverable is what the numbers revealed about behavior:

- **How** did runs fail — wrong file, hallucinated API, gave up early, passed the test but broke
  something untested, edited the test instead of the code?
- Where does performance drop — ambiguous specs, multi-file changes, unfamiliar frameworks,
  non-English code?
- Does more thinking correlate with passing, or just with cost?
- **Was it right for the right reasons, or right by luck?** Separate outcome-correctness from
  process-correctness. They diverge more than expected, and the divergence is the finding.

## Rule 7 — Argue against your own result

Every README states the limitations of its own method, in the README, not in a footnote. If a
metric flatters the thing being measured, say so and estimate the size of the effect. If a
favourable number is circular, disqualify it yourself.

A stated limitation reads as rigor. A discovered one reads as an error.

## Rule 8 — Delete metrics that measure the wrong thing, and record the deletion

A check that policed phrasing rather than substance, a score that another check already covers, a
metric that a reword defeats — remove it, and write down why in the README. Removing a bad metric
is a result. Silently keeping it is a bug in the eval.

## Rule 9 — No leaderboard framing

The point is measurement judgment, not declaring a winner. "Model X wins" is the least interesting
sentence available. Prefer: where each system is adequate, where it silently isn't, what the
trade-off costs, and what non-model lever moves the outcome more than the model choice does.

Recommending against every option tested is a legitimate conclusion.

## Rule 10 — Real tasks, not synthetic ones — with one exception

Draw tasks from real commit history, real bugs, real questions. Reviewers spot invented tasks
immediately.

**The exception is planted ground truth.** When measuring recall you must know what is findable, so
a synthesized fixture with deliberately planted findings and decoys is the correct design, not a
compromise. When you do this, say so and say why.

## Rule 11 — The README is the deliverable

Each eval folder's README, in this order:

1. **What this measures and why** — 3–4 sentences, no preamble
2. **Methodology** — enough to reproduce or critique, limitations included
3. **Findings** — 3–5 concrete claims, each backed by data in the folder
4. **What I'd change about the system's behavior based on this** — opinionated, specific,
   falsifiable
5. **How to run it**

Write as an engineer publishing a result. Not as a candidate, not as a portfolio piece. **No
mention of any job application anywhere in this repository.**

## Rule 12 — Never report a run that didn't happen

Results committed here are real outputs of real runs. Do not write a findings section from
expectation, do not fill a results table with plausible numbers, do not describe an eval as run
when only the harness exists.

If the harness is built and unrun, the README says exactly that.

---

## Layout

```
<eval-name>/
├── README.md      # the deliverable
├── tasks/         # task or case definitions, declarative
├── harness/       # runner
├── results/       # raw outputs, committed, with run metadata
└── analysis/      # scripts turning results into the README's findings
```

## Current contents

| Folder | State |
|---|---|
| `swe-production/` | **Harness partially built, unrun.** SWE-bench-style suite; tasks extracted from real fix commits with their tests. No tasks written yet |

## Conventions

- Node ESM (`.mjs`), no build step, no framework
- Commit raw results with metadata; never regenerate a committed result to make it look better
- One folder per eval; no shared state between them
- Secrets via environment only, never committed, never in a fixture
