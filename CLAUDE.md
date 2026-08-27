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

Two shapes, because two kinds of eval live here. Pick by whether the model needs tools.

**Single-turn** — the model is handed data and asked for one answer. No tools, no agent loop, so a
plain completion isolates the thing being measured. Three of the four evals are this shape.

```
<eval-name>/
├── README.md      # the deliverable (Rule 11)
├── fixture/       # the frozen input the model sees (Rule 3)
├── tasks/         # case definitions, declarative — a JSON file is enough
├── outputs/       # raw run output, committed, one file per model per trial
├── run.mjs        # asks each model every case
└── score.mjs      # turns outputs into numbers, deterministically (Rule 4)
```

`golden/` appears too, where expected answers are large enough to want their own files rather than
inline `expect_*` fields.

**Agentic** — the model works in a loop with tools, so the scaffold is a variable in its own right
and gets named and held fixed. `swe-production` is this shape.

```
<eval-name>/
├── README.md
├── fixtures/      # the repository or environment the agent works in
├── tasks/         # task definitions
├── harness/       # runner, scaffold adapters, pricing
├── models.json    # models under test — adding one is config, not code
├── results/       # raw run output, one directory per run, with metadata
└── analysis/      # scripts turning results into the README's findings
```

## Adding an eval

The rules above are about judgment. This is the procedure.

1. **Check it does not already exist** (METHODS.md §17). A variant of an existing eval is usually a
   new case or a new condition in that folder, not a new folder.
2. **Write the README first**, at least sections 1 and 2 of Rule 11 — what this measures, and how.
   If you cannot state what a result would mean before running anything, the design is not ready.
3. **Pick the layout** above and create the folder. Copy the closest existing eval; there is no
   scaffold script and none is wanted, because copying a working one carries its conventions.
4. **Freeze the fixture** and say in the README why it is frozen (Rule 3).
5. **Write the cases declaratively.** A case is data, not code — see
   `grounded-response-id/tasks/questions.json` for the shape: an `id`, a `class`, the input, the
   expected behaviour, and a `tests` field saying *why this case exists*. That last field is what
   stops a suite drifting into cases nobody can justify.
6. **Include a negative control** (Rule 2) — at least one case whose correct outcome is failure.
7. **Check what a lazy answer scores** (METHODS.md §3) before choosing a headline metric. If
   "nothing is wrong" scores 80%, the metric is broken and no amount of running will fix it.
8. **Score deterministically** (Rule 4). Reach for a judge model only when there is no alternative,
   and then pin it and validate it.
9. **Run at least three trials** and commit the raw outputs with their metadata (Rule 5).
10. **Finish the README** — findings, limitations argued against yourself, and how to run it
    (Rules 6, 7, 11).
11. **Update `Current contents`** below. An eval nobody can find from the front door does not exist.

Adding a **case** to an existing eval is step 5 plus step 9, and nothing else. Adding a **model** is
an entry in `models.json` or `MODELS` in `lib/client.mjs` — configuration, not code.

## Backends

The single-turn evals speak the OpenAI chat-completions shape, so they are not tied to a provider.
`EVAL_BACKEND` selects where calls go; the eval code never learns which is in use. Registry and
per-backend model ids are in `lib/backends.mjs`, the client is `lib/client.mjs`, and the README
documents the environment variables.

Three constraints on that layer:

- **OpenRouter stays the default.** Every published number came through it. Changing the route
  silently would make a score difference unattributable to model, prompt, or gateway.
- **No private endpoint is ever committed.** Gateway and self-hosted backends take their URL from
  the environment. This is Rule 1 applied to configuration.
- **Cost is reported only where the provider reports it.** Elsewhere `costUsd` is `null` with
  `costSource: 'unavailable'` — never `0`, which would read as a free call.

Temperature is not sent by default. The current model generation has retired it: the Claude 5
family and the GPT-5.6 line reject any explicit value, while Claude 4.5, GPT-5.4 and the
open-weight tier still accept one. Determinism comes from trials (Rule 5), not from pinning.

## Current contents

| Folder | Shape | State |
|---|---|---|
| `agent-report-scoring/` | single-turn | **Done.** 4 models. Given a week of usage data, does the model find the real problems and ignore the planted decoys? |
| `grounded-response-id/` | single-turn | **Done.** 4 models. Does a shop assistant answer from the shop's data, admit what it does not know, and refuse what it must not share? In Indonesian |
| `cve-remediation/` | single-turn | **Done.** 4 models, 48 runs. Can it clear a real advisory without deleting the package or silencing the scanner? |
| `swe-production/` | agentic | **Done.** 2 economy models, 9 tasks, 3 trials, 54 runs. Private task suite, so the numbers are not reproducible by a reader — the harness is public, the tasks are not |

Keep this table current. It is the only place that says what state each eval is actually in, and
Rule 12 applies to it as much as to a README.

## Conventions

- Node ESM (`.mjs`), no build step, no framework
- Commit raw results with metadata; never regenerate a committed result to make it look better
- One folder per eval; no shared state between them, beyond `lib/`
- Secrets via environment only, never committed, never in a fixture
- **Baseline prompts are not edited in place.** Every published number was produced with the exact
  prompt in the file. A variant is added as a new named condition with the original kept as the
  control, so a score change is attributable to the prompt rather than confounded with it
