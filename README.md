# evals

Tests that measure how well AI models do real work, and how they fail.

Each folder is one test: what it measures, how, what it found, and how to run it yourself. The raw
results are committed next to the code that produced them.

## The short version

Four models were tested across the first three, from expensive to cheap: `claude-sonnet-5`, `gemini-3.6-flash`,
`glm-5.2`, and `deepseek-v4-flash`. The cheapest costs about 1/37th of the most expensive.

**There is no single "best model." It depends entirely on the job.**

| The job | Who won | The number |
|---|---|---|
| Analysing usage data | **The cheap model** | glm-5.2 beat both expensive models at 1/5 the cost |
| Answering customer questions | The expensive model | but see below, this one is not really about winning |
| Clearing a real security advisory | **The cheap model, for 7 cents** | deepseek matched Sonnet on every case at 1/21 the cost |
| Fixing real bugs in real code | **Not yet answered** | first matrix withdrawn after a harness bug; fixed and awaiting rerun |

So a cheap model can be better than an expensive one, worse than an expensive one, or exactly the
same, depending on what you ask it to do. Any article telling you which model is "best at AI agent
work" is averaging over jobs that disagree with each other.

## The finding that matters more than the rankings

**The dangerous failures do not look like failures. They look like success.**

**A customer service agent leaked private data.** The cheapest model answered every ordinary
question correctly, matching the clean expensive model on that column. Then, asked whether another customer had
paid their bill, it gave out that customer's invoice number, unpaid status, and the amount owed, to
someone who had not proved who they were. It did this every single time it was asked.

Everything it said was true and came from the data it was given. It did not make anything up. Any
check that asks "is this answer accurate?" passes it. The answer was accurate and should never have
been said.

This is not the model being incapable. It is the model being confidently wrong in a way
that looks finished. That is why every test here scores *how* the model worked separately from
*whether* it got the right answer, and why none of them report a single overall score.

## The tests

| Test | The question it asks | Status |
|---|---|---|
| [`agent-report-scoring/`](agent-report-scoring/) | Given a week of usage data, does the model find the real problems and ignore the fake ones? | Done, 4 models |
| [`grounded-response-id/`](grounded-response-id/) | Does a shop assistant answer from the shop's data, admit when it doesn't know, and refuse what it shouldn't share? In Indonesian. | Done, 4 models |
| [`cve-remediation/`](cve-remediation/) | Given a real CVE in a project's dependencies, can it clear the advisory without deleting the package or silencing the scanner? | Done, 4 models, 48 runs |
| [`swe-production/`](swe-production/) | Can it fix real bugs from a real business application? | Awaiting rerun. First 27-run matrix withdrawn after a harness bug; fix now smoke-tested |

The first three include everything needed to run them and will give you the same numbers we got.
The fourth will not: it runs against a private codebase, so the tool is public but the test cases
are not. That trade is explained in its own README.

## How these tests are built

The full reasoning is in [`METHODS.md`](METHODS.md). The short version, in plain terms:

**Include something that should fail.** Every test has at least one case where the correct outcome
is failure. Without one, a perfect score might mean the model is perfect, or it might mean the
scoring is broken and can never fail anything. You cannot tell which.

**Check what a lazy answer would score.** If saying "nothing is wrong" to everything gets you 80%,
then 80% is a meaningless number and the scoring needs rethinking before anything is published.

**Ask what the model did, not just what it answered.** A right answer reached without doing the
work is luck, and luck does not repeat. So these tests record whether the model actually read the
error before editing, whether it checked its work, and whether it claimed more than it could
support.

**Run everything at least three times.** Models are not consistent. Several tasks here passed on
one attempt and failed on the next with identical input. A single run tells you almost nothing, and
a number from a single run should not be trusted.

**Say what is wrong with the test, in the test's own writeup.** Where a measurement flatters the
thing being measured, that is written down next to the result rather than left for a reader to
notice.

**No winners lists.** "Model X is best" is the least useful thing these could produce. More useful:
where each one is good enough, where it quietly is not, and what you can change that matters more
than which model you pick.

## A few words you will see repeatedly

- **fixture** — the fake but realistic data a test runs against, written so we know in advance
  what the right answers are
- **harness** — the code that runs the test and records what happened
- **scaffold** — the software wrapped around a model that lets it read files and run commands.
  Different scaffolds give very different results from the same model, which is why one test here
  holds the scaffold fixed and only changes the model
- **recall** and **precision** — recall is how much of what mattered the model found; precision is
  how much of what it reported actually mattered. A model can score well on one and badly on the
  other, so both are always shown

## Running them

Node 20+. Each folder explains its own setup. Nothing needs a service beyond what its README names,
and no test data contains a real password, customer, or company.
