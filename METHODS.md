# Methods

Techniques this repo uses, and the failure each one prevents.

Most of these exist because a naive version of the same eval produced a number that looked fine
and meant nothing. They are written as general practice; each is applicable well beyond the evals
in this repository.

---

## 1. Negative controls

**Include something that should fail, and confirm it does.**

A result showing only the system passing cannot distinguish a working system from a scorer that
cannot go red. Every eval needs at least one case whose correct outcome is failure: a deliberately
broken input, an unsolvable task, a fixture with the answer removed.

The negative control is what makes the positive result mean anything. Without it, "5 of 5 checks
passed" is equally consistent with a harness that always passes.

## 2. Outcome correctness and process correctness are different measurements

**Score whether the system got the right answer and whether it did the work, separately.**

A system can reach a correct answer without reasoning: checking the components it happens to have
tooling for, editing plausible files until the tests stop failing, or answering "no action needed"
where that happens to be true most of the time. Outcome-only scoring rates that identically to
genuine diagnosis.

Read process from the tool-call trace — did it consult the evidence before acting, did it act on
the thing the problem actually concerned, did it verify. Report the two as separate columns and
expect them to diverge. **The divergence is usually the most useful thing in the run.**

## 3. Check what a lazy answer would score, before choosing a headline metric

**Ask what the laziest possible answer would score.**

If a system that answers "not affected" to everything, or returns nothing at all, scores well on
your headline number, the headline number is wrong. This is common whenever the correct answer is
skewed — most repositories are unaffected, most inputs are benign, most runs need no action.

The fix is not a cleverer single metric. It is refusing to publish one: report recall on the
positive class separately from overall accuracy, report precision beside it, and let the reader
see the shape.

## 3b. Prefer a judge you do not control

**When a task has an external referee, use it.**

A test where you write the ground truth inherits every mistake in your ground truth. A test judged
by something outside the project — a test suite the original developer wrote, a package registry, a
vulnerability scanner — cannot be quietly bent to fit the result you expected.

This repository contained both versions of the same test. The first invented vulnerable packages
and planted traps; all four models scored 100% and it could not tell them apart, because traps you
design yourself are traps you already know how to avoid. It was replaced by one built on real
advisories against real packages, where the verdict comes from `npm audit` rather than from a file
in this repo. The replacement immediately found something the synthetic version could not: the
fixture author's own assumption about which cases were solvable was wrong, and the models proved it.

The synthetic version has been deleted rather than kept alongside. Shipping a test you have already
declared unable to discriminate, next to its replacement, asks readers to work out which one counts.

## 4. Identical inputs across conditions, and show that they were identical

**Pin the prompt, the data, and the versions — then cite where that's enforced.**

Two systems are only comparable on identical evidence. When comparing models, the prompt must be
byte-identical and the claim should point at the code that guarantees it. Otherwise any difference
observed is confounded with prompt engineering, and a reader has no way to know which.

Same for data: freeze the fixture, pin the commit. Against live data, a score change cannot be
attributed to the thing that changed, because the ground moved too.

## 5. Planted ground truth, when recall is the question

**You can only measure recall against findings you know are present.**

Synthesized fixtures are the correct design for recall — not a compromise. Plant the findings the
system should surface, plant decoys it should not report, and precision and recall both become
measurable. Hand-labelling real data is the alternative, and it does not scale past the first few
dozen cases.

This is the one place where synthetic beats real. Everywhere else — task suites especially — real
history beats invented scenarios, and readers can tell.

## 6. Sentinels, so retrieval can't pass by luck

**Make the target unique to the document that should be found.**

A retrieval test where the answer term appears in several documents cannot distinguish correct
retrieval from a lucky hit. Place a term that occurs in exactly one document and query for it.
Same principle as a negative control, applied to search.

## 7. Defend the metric against the obvious alternative

**Say why you measured what you measured, not just what you measured.**

Answer accuracy is the intuitive metric for a question-answering system — and it is wrong when the
answers live in the model's parametric knowledge, because the model will answer correctly whether
retrieval worked or not. Measure what the system retrieved instead.

Whenever the intuitive metric would be contaminated by something outside the system under test,
say so in the methodology. A reader who thinks of the objection you already handled loses trust in
everything else.

## 8. Name the asymmetry when your metric has one

**If the measurement favours one side structurally, estimate the size of it.**

A metric like "does the retrieved context contain the answer" rewards systems that return more
surface area. That is a real property, not a trick — but it means a 10-vs-8 result overstates the
gap, and a token-budget-matched comparison would narrow it.

State this in the findings, not a footnote. A limitation you declare reads as rigor; the same
limitation found by a reader reads as an error.

## 9. Disqualify your own self-confirming results

**When a favourable number was produced by the same process that defined correctness, say it
doesn't count.**

Hand-writing the expected output from the same analysis that produced the golden set makes recall
self-confirming. The deterministic checks around it may still be sound — but the flattering number is
unproven until something independent produces it.

Doing this yourself is cheap. Having a reader do it is expensive.

## 10. Delete metrics that measure the wrong thing, and record the deletion

**A check that a rewording defeats was measuring phrasing, not substance.**

If a regex-based check fails a correct output for how it was worded, and passes the same content
reworded, it is not measuring what its name claims. Remove it. Also remove checks that another
check already covers — two names for one signal double-count it.

Write down what was removed and why. Removing a bad metric is a result. Silently keeping it is a
bug in the eval.

## 11. Report the range, not just the median

**Cost and latency variance are decision inputs, not noise.**

A system with a lower median cost and an unprojectable spread is a different operational
proposition from a dearer, tighter one. You can budget for the second and not the first. The same
holds for latency: a wide tail changes what you can build on top.

Minimum three runs per condition, and publish the spread. Single-run numbers presented as stable
are the most common failure in published evals.

## 12. Instability is a finding, not noise to average away

**The same input, the same system, different outcomes — report which cases do that.**

Which tasks are unstable across identical runs is often more interesting than the mean, and is
invisible in any single-run report. It also tells you where the mean is meaningless.

## 13. Look for the non-model lever

**The finding is often that it isn't a model problem.**

When a system underperforms, the available conclusions include: the model is worse, the tooling is
missing, the prompt is wrong, the data is stale. Tool-call traces usually distinguish these. A
result that says "the gap closes by adding tooling rather than changing models" is more actionable
than any ranking, and cheaper to act on.

Related: report the cost lever separately from the quality lever. They are usually independent, and
the cost one is usually larger.

## 14. Safety enforced by the harness, never by the prompt

**If a run must not mutate anything, make mutation impossible rather than forbidden.**

Withhold write-capable credentials, run against a copy, and add a guard that fails the run on an
attempted write. An instruction not to do something is not a control.

And record attempted violations rather than silently blocking them. A system that tries to do the
forbidden thing is reporting something about itself.

**A worked example, from this repository.** The coding eval ran each task in an isolated git
worktree and set the agent session's working directory to it. That looks like containment and is
not: a working directory does not bound writes, because an absolute path reaches anywhere the
process can.

Given a vague task, one run walked out of its worktree and wrote about a hundred lines into a
*different repository* on the same machine — on its main branch, including a changelog edit that
recategorised an existing entry. The code was plausible and on-topic. It was also uncommitted
changes in a live product repository that nobody had asked for.

Three things had to be true at once: the turn cap was dead code (it counted an event the runtime
never emits), nothing confined writes, and the task prompt was vague enough that a sibling
repository looked like a reasonable place to solve it. Any one of them alone would have been
survivable.

**A second worked example, on the same rule.** The guard written in response to that incident was
itself inert for every run it supervised. It read the tool's arguments from the first parameter;
the runtime passes the tool-call id first and the arguments second, so the guard inspected a string,
found no paths in it, and allowed everything. It was covered by a unit test — which called it with
the wrong convention too, and therefore passed.

A control that has never been observed rejecting a real attempt is not known to work. Test it
against the calling convention the system actually uses, not the one the test author assumed, and
prefer an end-to-end smoke test over a unit test for anything whose job is to say no.

The uncomfortable part is that **this rule was already written here before the incident that
proved it.** Knowing the principle is not the same as having built the control, and a repository
that documents a safety practice while shipping a harness without it is worse than one that does
neither. It reads as assurance it has not earned. Check that each control named here actually
exists in the code, and treat "I know about that failure mode" as the beginning of the work rather
than the end of it.

## 15. Attribution requires versioning, and versioning comes first

**A score is meaningless unless you know which version produced it.**

If prompts or configuration are edited in place with no history, no past result can be attributed
to the input that produced it — yesterday's comparison is invalid the moment someone edits a text
box, and nothing surfaces that. This blocks every other measurement, so it gets built first.

## 16. Recorded tool results turn past runs into fixtures

**If a system logs tool calls with their arguments and their results, replay is nearly free.**

Serving the recorded results in place of live calls lets a new configuration run against exactly
what an old run saw. That is the basis of an attributable comparison, and the data usually already
exists.

The honest ceiling: replay is faithful only while the new configuration makes the same calls. One
that asks a different question falls outside the recording and has to run live. Treat replay as the
fast path, not the only path.

## 17. Ask whether it already exists before building it

**Survey the field first, then decide what to copy.**

Prompt and eval tooling is a solved-ish problem with converging vocabulary — versions, labels,
typed scores, annotation queues, online versus offline evaluation. That convergence is itself
evidence a design is right, and adopting the vocabulary beats inventing one.

Adopting the *deployment* is a separate and harder question: a mature platform can mean a second
stateful system beside one that needs a single database today. Copying the data model is often the
right answer where running the platform is not.

## 18. Exclusions are reported, never dropped

**An invalid case is a fact about the suite.**

Tasks excluded for being malformed, runs that errored, conditions that were sampled rather than
exhausted — list them with counts. Silent truncation reads as full coverage when it wasn't, and the
excluded set is often where the interesting problems are.

## 19. Never report a run that didn't happen

Results are outputs of real runs. No findings written from expectation, no plausible-looking
numbers filling a table, no describing an eval as run when only the harness exists.

If the harness is built and unrun, the write-up says exactly that.
