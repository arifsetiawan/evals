# swe-production

A harness for measuring how a coding agent behaves on **real bugs from a production codebase**.
The first paid model run was withdrawn after a harness defect, so this currently ships as tooling,
methodology, sanitized example fixtures, and a smoke-tested preflight rather than model findings.

This is not a public dataset. It is a tool you can point at your own repository. The private task
suite, and the status of the withdrawn first run, are discussed under *Reproducibility* below.

> Not affiliated with SWE-bench. The task construction is the same idea — base the task before the
> fix, apply only the tests, make the agent write the code — but the tasks, the corpus, and the
> harness are unrelated to it.

## Two experiments

Model quality and scaffold quality are different questions, and a benchmark that varies both at
once measures neither.

| | Holds fixed | Varies | Question |
|---|---|---|---|
| **A — models** | scaffold (Pi) | model | Which model is better at this task? |
| **B — scaffold** | model (Sonnet) | scaffold | How much of a vendor's coding performance is the model, and how much is their own harness? |

**Pi** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
is the control scaffold for A because it is the only one that speaks to every provider. Running
Sonnet through Claude Code and everything else through a bare API loop would attribute the
scaffold's advantages to Anthropic's model.

**Claude Code** is retained as the second scaffold for B, where the model is held constant and only
the harness changes. That comparison is the more novel of the two — everyone benchmarks models;
almost nobody isolates what the vendor's own agent loop contributes.

Models are configuration, not code: see `models.json`. Four are enabled, one per price band,
spanning ~18x. Disabled entries are kept with the reason they were dropped, because a suite that
quietly removes models reads as coverage it does not have.

## Cost design

The grid is run cheapest-first rather than all at once. Economy models run every task; frontier
models run only the tasks the economy models could not do.

This is not only cheaper. It matches the question. *Where does the cheap tier stop being
adequate?* is answered by running cheap models everywhere and expensive models where cheap ones
break. Running a frontier model on a task the cheapest model already solved for pennies tells you
nothing you would act on.

**The cost of that design, which has to stay visible in any write-up:** frontier models are only
evaluated on the hard subset, so their aggregate pass rate is not comparable to the economy models'
on the full set. Results are reported **per task**, never as a headline rate across a selected set.

## What this measures and why

Most published coding benchmarks draw from open-source libraries, which have a particular shape:
well-factored modules, thorough test suites, contributors who write careful issue reports. A
production business application is not that. It has framework coupling, database access in the
middle of business logic, bug reports that arrive as "the invoice is wrong," and a codebase where
the fix for a payment bug lives three directories from where the symptom appeared.

Agents behave differently in that environment, and the difference is what this measures.

The construction is possible because the source repository's bugfix commits ship their regression
tests alongside the fix. Check out the commit *before* the fix, apply only the test files, and the
agent has to write the code that turns them green. The bugs are real, the tests are the ones the
developer actually wrote, and pass/fail is decided by a test runner rather than an opinion.

The interesting output is not a pass rate. It is the breakdown of how it failed — which tasks are unstable
across identical runs, whether the agent edits the code or the test, whether it claims a fix the
suite does not support, and whether it did the diagnostic work or arrived by luck.

## Reproducibility — read this before trusting any number below

**The task suite is private.** It is derived from a closed-source production application, and
neither the task definitions nor the run transcripts can be published: transcripts contain roughly
50 KB of real source per run.

That has one cost and one benefit, and both are real.

**The cost:** you cannot reproduce the specific numbers in this README. You are taking them on
trust. Do not treat them as you would a reproducible benchmark result.

**The benefit:** the suite is uncontaminated by design. Public benchmarks have a known
memorisation problem — their tasks are in the training data of the models they score, and
separating capability from recall is an open research question. A suite built from a private
repository's commit history cannot have leaked into any model's training set. That property is
hard to get any other way, and it is the reason this is worth running at all rather than adding
another public suite.

**What you can verify:** point the harness at your own repository and it will build tasks from your
own fix commits, provided that repository uses **vitest**. The methodology below is complete enough
to critique, and the scoring code is here in full.

The vitest limit is worth stating precisely, because three things extend different distances:

| | Coverage |
|---|---|
| Repository layout | General. npm workspaces, pnpm workspaces, and single-package repos are detected from the repo itself. Verified against three real repositories of different shapes |
| Test runner detection | vitest, jest, `node --test` |
| **Reading the results** | **vitest only** |

A jest repository is detected correctly and then refused, with the reason printed. That is
deliberate: running the tests and misreading the output would report every task as failing, which
looks like a model result and is not one. Each runner emits a different report format, and the
collection-error case alone caused four separate bugs in the vitest parser — so a second parser
gets written and tested against a real repository, not written blind.

An earlier version of this section claimed the harness was simply repo-agnostic. It was not: the
workspace list was one repository's directory names hardcoded (and incomplete even for that one),
the vitest config path was fixed, and a single-package repo had every commit misread as spanning
multiple workspaces. Those are fixed and detection is now verified across three layouts. The
runner limit is the part that remains.

**What is published:** the harness, the extractor, the analysis, the methodology, and nine
sanitized example fixtures under `fixtures/` so you can see the shape of a task without the
originating codebase. Those are derived from real commits with customer names, document numbers,
identifiers and incident notes mechanically removed — see `harness/sanitize.mjs`, which refuses to
write a fixture at all if a denied term survives redaction.

## Methodology

**Task construction.** Each task is one bugfix commit:

- **Base state**. The commit's parent, checked out into an isolated git worktree
- **Applied tests** — only the test files from the fix commit, copied onto that base
- **The prompt**. The bug as a developer would report it, written by hand not to leak the fix
- **Pass criteria**. The applied tests pass, and a regression set that passed before still does

**A task is only valid if its tests fail at base state, for an identifiable reason.** Checked on
every run, not once at extraction. A dependency or fixture change can invalidate a task later.

"Not green" is not sufficient evidence. Three distinct conditions produce a red suite and only one
means the task is sound:

| Condition | Verdict |
|---|---|
| Assertions fail | Valid — `redVia: failing-assertions` |
| Collection fails because the fix commit *creates* the module under test | Valid — `redVia: collection-error` |
| No test files matched the pattern | `INVALID_TASK` — proves nothing |
| Zero assertions with no identifiable collection error | `INVALID_SETUP` — cannot establish the suite is red for the right reason |

The distinction matters because the first two both report `{passed: 0, failed: 0, total: 0}` with a
non-zero exit. Separating them requires reading the runner's own output, not its counts.

**Negative controls.** Two tasks exist whose correct outcome is rejection, and they run in the
suite:

- `negctl-already-green` — base commit set to the fix commit, so the tests pass at base. Must be
  caught by the already-passing gate.
- `negctl-no-tests` — test files declared under a workspace that does not contain them, so nothing
  runs. Must be caught before any agent is paid.

Both are rejected with distinct reasons and zero agent spend. Without them, "the gate works" would
be an assertion rather than a demonstration — and the second control is not hypothetical: writing
it exposed a live defect where that path returned a bare `{ok: false}`, leaving every gate
condition falsy. Tasks with no runnable tests were being graded, paid for, and recorded in the
a breakdown of how it failed as legitimate failures.

**Isolation.** One git worktree per run, pinned to the base commit, destroyed afterwards.
Dependencies are symlinked from a source checkout rather than installed per run, so every run sees
an identical dependency tree. A fresh install could resolve different transitive versions on
different days, which is an uncontrolled variable in a measurement meant to isolate the model.

**Scoring is deterministic.** Vitest decides pass/fail. No model sits in the scoring path, so
re-scoring a run always yields the same verdict, and any variance in results is variance in the
agent.

**Test tampering is detected, not scored.** Weakening a failing assertion turns a suite green
without fixing anything. Every run is checked for modifications to the applied test files, and
those runs are reported separately rather than folded into a pass rate.

**Process correctness is measured separately from outcome.** A green suite does not establish that
the agent diagnosed anything. It can be reached by editing plausible-looking files until the tests
stop failing. Outcome and process are scored as two columns, using signals read from the tool-call
trace:

| Signal | Distinguishes |
|---|---|
| Did it read the failing test before editing? | Diagnosis from guessing |
| Did it edit the file the bug was actually in? | Fixing the cause from patching a symptom |
| Did it run the tests itself before declaring done? | Verification from assertion |
| Does its final message claim more than the suite supports? | An honest report from an overclaimed one |

**Variance is measured, not averaged away.** Minimum three trials per task per model, spread
reported.

**Cost and behavior come from the agent's own accounting.** Headless Claude Code reports token
usage, cost, turn count, duration and permission denials per run; the harness records what the CLI
reports and adds no instrumentation of its own.

### Limitations

- **One codebase, one language, one test runner.** Findings describe agent behavior on a
  TypeScript/Next.js/Prisma monorepo. They do not generalise without evidence.
- **The tests define correctness.** An agent can satisfy them while breaking something untested.
- **Fix commits are selected, not sampled** — chosen for having self-contained tests, which biases
  toward well-scoped bugs.
- **The repository's own `CLAUDE.md` is in context**, as it would be for a developer working there.
  Deliberate, but it means results reflect this repo's conventions, not a cold codebase.
- **Prompts are written by one person** who knows the codebase. A prompt that describes the
  mechanism rather than the symptom makes a task easier than it should be.
- **Cost figures are list price at time of run** and will drift.

## Current status

**Model findings are pending a rerun.** The harness and methodology are usable, but the first
27-run Pi matrix is not evidence about model quality. It was produced by an agent that could read
and edit files but could not run shell commands, so it measured a broken tool connection rather
than a coding model.

`createCodingTools` takes a working directory as a string. It was called with an options object,
which stringified to `[object Object]`, so every shell command returned *"Working directory does
not exist"* while file reading and editing kept working normally. The agent looked functional. It
could not run a test, grep for a symbol, or inspect anything it had not already opened.

The error appears in 27 of 27 transcripts from that matrix. Claims derived from those runs were
withdrawn:

| Withdrawn claim | Why it does not stand |
|---|---|
| Headline pass rate | Measures a model with no shell, not a model |
| Read-the-test-first rate | Plausibly an artifact of having no way to search |
| Ran-tests-itself rate | It *attempted* to; every attempt errored. The signal counted the call, not the result |
| Turn-cap count | A model that cannot verify anything will naturally cycle |

The cost figures are also affected, though differently: they are real money that was really spent,
but on runs that were not measuring what they claimed to.

**What is ready to use.** The harness mechanics were verified independently: the
base-state gate, the negative controls, worktree isolation, tamper detection, deterministic
scoring, the sandbox guard, and the replacement Pi tools smoke test. The task suite still needs a
paid rerun before this page can make claims about any model.

**A related failure, found the same way.** The sandbox guard added after an agent escaped its
worktree was inert for every run it supervised: it read the tool arguments from the wrong parameter
position, so it inspected a string, found no paths, and permitted everything. Its unit test used the
same wrong convention and passed. It is now exercised by `npm run smoke:pi-tools`, which drives the
real tools end to end — shell cwd, grep, a failing test, an edit, a passing test, and a rejected
escape — and costs no model tokens.

**What this cost to find.** Four earlier harness defects in this eval each produced a plausible
wrong result rather than a crash: an empty toolset that read as "the cheap model cannot code", a
dead turn cap, a stale worktree registration that looked like task failure, and a collection-error
check reading the wrong stream. This is the fifth and the most expensive, because it survived a
smoke test — the smoke test used a one-line file the agent could fix with `read` and `edit` alone,
so bash never mattered and its absence never showed.

A smoke test has to exercise the thing that is hard, not the thing that is quick.
The replacement smoke test is `npm run smoke:pi-tools`: it creates a throwaway project, uses Pi's
bash tool to `grep` across files, runs a failing test suite, edits the source through Pi's edit
tool, and then runs the same test suite green. It spends no model tokens.

## Model behavior takeaways

Nothing yet. The one run that produced results was measuring a broken harness, and the honest
position is that this eval has not yet said anything about any model.

This section stays empty until the fixed harness has been run against the task suite.

## How to run it

```bash
npm run smoke:pi-tools                                  # preflight Pi tools before paid runs
node harness/extract.mjs  --repo <path> --candidates       # commits changing both tests and source
node harness/extract.mjs  --repo <path> --commit <sha>     # → tasks/<id>.json (a DRAFT)
node harness/run.mjs      --repo <path> --models sonnet --trials 3
node analysis/report.mjs  --results results/<timestamp>
node harness/sanitize.mjs --repo <path> --all              # → publishable fixtures/
node harness/sanitize.mjs --repo <other> --redaction rules/other.json --all
```

Extraction emits `"draft": true` and the runner refuses drafts. The generated prompt is the commit
subject, which describes the fix and leaks the answer — rewriting it as a symptom report is manual
and is the step that decides what the task actually measures.

```
harness/extract.mjs   commit → task definition
harness/sanitize.mjs  task → publishable fixture, with a deny gate that fails closed
harness/redaction.example.json  template for the rule file (the real one is gitignored)
harness/run.mjs       tasks × models × trials
harness/lib/          worktree lifecycle, deterministic scoring, headless agent driver
analysis/report.mjs   a breakdown of how it failed, variance, process vs outcome, cost
fixtures/             sanitized examples (not runnable standalone — see below)
```

**On what was removed from them.** The first pass scrubbed customer names and document numbers,
passed its own scan, and still shipped internal audit references, a named competitor, module paths,
and product reasoning written in code comments. A deny list only finds what its author already
thought of. The rules were widened after enumerating what was actually in the files rather than
guessing, and comment blocks containing product or competitive reasoning are now removed whole —
removing a single line there left a fragment that still carried the point.

What remains is roughly 10,800 lines of real source with its identifying references removed. That
is a deliberate trade, not an oversight: the code is what makes a task real, and stripping it
further would leave nothing worth looking at. Anyone reusing this tooling on their own repository
should assume their first rule file is too narrow and check the output by hand.

**Note on `fixtures/`:** these are illustrative, not executable. The extracted slices import from
the wider application (`@prisma/client`, `next/server`, sibling modules), so they show a task's
shape without running on their own. Making them self-contained would mean either selecting only
bugs in dependency-free modules or stubbing the imports, and stubs would become part of what is
under test.
