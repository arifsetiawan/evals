#!/usr/bin/env node
/**
 * Run tasks × models × trials.
 *
 *   node harness/run.mjs --repo <path> [--models sonnet,opus] [--trials 3]
 *                        [--tasks tasks/] [--only <task-id>] [--dry-run]
 *
 * Each run is one worktree pinned to the task's base commit, with only the fix
 * commit's test files applied on top. The agent has to write the code that
 * turns them green.
 *
 * Results land in results/<timestamp>/ with one record per run and the raw
 * transcript alongside it.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './lib/agent.mjs';
import { runPiAgent } from './lib/pi-agent.mjs';
import {
  applyTestFiles,
  changedFiles,
  createWorktree,
  diffStat,
  linkDependencies,
  removeWorktree,
  testFilesTampered,
} from './lib/repo.mjs';
import { runTests } from './lib/vitest.mjs';
import { detectLinkDirs, detectRunner } from './lib/detect.mjs';
import { stamp } from './lib/util.mjs';

// Layout is detected from the repository, not declared here. The hardcoded list
// this replaced named one repository's workspaces — and was incomplete even for
// that one, missing three of its eight.
let LINK_DIRS = [''];
const RUNNERS = new Map();

async function runnerFor({ repo, workspace }) {
  if (!RUNNERS.has(workspace)) RUNNERS.set(workspace, await detectRunner({ repo, workspace }));
  return RUNNERS.get(workspace);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function loadTasks(dir, only) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const tasks = [];
  for (const f of files) {
    const task = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (only && task.id !== only) continue;
    if (task.draft) {
      console.warn(
        `SKIP ${task.id}: still a draft. Rewrite the prompt so it describes ` +
          `the symptom rather than the fix, then set draft:false.`
      );
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}

/**
 * Process-correctness signals, read from the tool-call trace.
 *
 * A green suite does not establish that the agent diagnosed anything — it can
 * be reached by editing plausible files until the tests stop failing. These
 * separate the two, and are reported as their own column rather than folded
 * into the pass rate.
 */
function processSignals({ toolCalls, task, testsPassed, resultText }) {
  // Scaffolds name their tools differently — Claude Code uses `Edit`/`Read`/
  // `Bash`, Pi uses `edit`/`read`/`bash`. Matching one convention would make
  // every signal read false for the other scaffold, which looks exactly like a
  // model that never inspects anything. Normalised instead.
  const EDIT = new Set(['edit', 'write', 'notebookedit', 'multiedit', 'str_replace']);
  const READ = new Set(['read', 'grep', 'glob', 'find', 'ls', 'cat']);
  const SHELL = new Set(['bash', 'shell', 'run', 'exec']);
  const kind = (c) => String(c.name ?? '').toLowerCase();

  const firstEdit = toolCalls.findIndex((c) => EDIT.has(kind(c)));
  const readTestIdx = toolCalls.findIndex(
    (c) =>
      READ.has(kind(c)) &&
      c.target &&
      task.test_files.some((t) => c.target.includes(path.basename(t)))
  );

  const edited = toolCalls
    .filter((c) => EDIT.has(kind(c)) && c.target)
    .map((c) => c.target);

  // Compare repo-relative paths, not basenames. A substring match on the
  // basename cannot tell `api/v2/pos/receipt/[id]/detail/route.ts` from
  // `api/v2/pos/transactions/route.ts` — and one task in this suite has exactly
  // that pair, so the loose check would credit editing either as editing the
  // right one.
  const expected = task._expected_source_files ?? [];
  const relOf = (abs) => {
    const marker = `${path.sep}.worktrees${path.sep}`;
    const i = abs.indexOf(marker);
    if (i === -1) return abs;
    const after = abs.slice(i + marker.length);
    return after.split(path.sep).slice(1).join('/');
  };
  const editedRel = edited.map(relOf);
  const editedExpectedFile = editedRel.some((e) => expected.includes(e));

  const ranTests = toolCalls.some(
    (c) =>
      SHELL.has(kind(c)) &&
      typeof c.target === 'string' &&
      /vitest|npm (run )?test|npx test|node --test/.test(c.target)
  );

  // Did the final message claim success the suite doesn't support? A distinct
  // and more consequential failure than simply failing.
  // A bare keyword match would count "the tests are still not passing" as a
  // claim of success. Verified against the runs recorded here — none were
  // negated — but the check should not depend on that holding.
  const SUCCESS = /\b(fixed|resolved|passing|now passes|tests pass|working|complete)\b/i;
  const NEGATED =
    /\b(not|never|isn'?t|aren'?t|doesn'?t|didn'?t|still|unable to|cannot|can'?t|fails?|failing|no longer)\s+(\w+\s+){0,3}(fixed|resolved|passing|passes|working|complete)/i;
  const claimsSuccess =
    typeof resultText === 'string' && SUCCESS.test(resultText) && !NEGATED.test(resultText);

  return {
    readTestBeforeEditing:
      readTestIdx !== -1 && (firstEdit === -1 || readTestIdx < firstEdit),
    editedExpectedFile,
    ranTestsItself: ranTests,
    overclaimed: !testsPassed && claimsSuccess,
    editCount: edited.length,
    filesEdited: [...new Set(editedRel)],
    // The text the overclaim verdict is based on. Without it the finding
    // cannot be checked from the committed record — which was the case when
    // "six runs overclaimed" was first published.
    finalMessage: typeof resultText === 'string' ? resultText.slice(0, 600) : null,
  };
}

async function runOne({ repo, task, model, trial, outDir, dryRun, scaffold }) {
  // Model ids carry slashes; the run id becomes a filename.
  const slug = model.replace(/[^a-z0-9.-]/gi, '_');
  const runId = `${task.id}__${scaffold}__${slug}__t${trial}`;
  const worktree = path.resolve('.worktrees', runId);
  const record = {
    runId,
    taskId: task.id,
    model,
    scaffold,
    trial,
    baseCommit: task.source.base_commit,
    fixCommit: task.source.fix_commit,
    category: task.category,
    difficulty: task.difficulty,
    tags: task.tags,
  };

  try {
    await createWorktree({
      repo,
      baseCommit: task.source.base_commit,
      dest: worktree,
    });
    await linkDependencies({ repo, dest: worktree, dirs: LINK_DIRS });
    await applyTestFiles({
      dest: worktree,
      fixCommit: task.source.fix_commit,
      testFiles: task.test_files,
    });

    // The tests must fail at base state. A task whose tests already pass
    // measures nothing, and counting it would inflate every number downstream.
    // Checked on every run rather than once at extraction, because a
    // dependency or fixture change can quietly invalidate a task later.
    const runner = await runnerFor({ repo, workspace: task.workspace });
    const pre = await runTests({
      dest: worktree,
      workspace: task.workspace,
      testFiles: task.test_files,
      runner,
    });

    // The gate must establish *why* the suite is red, not just that it isn't
    // green. Three distinct failures share one symptom, and only one of them
    // means the task is sound:
    if (pre.ok) {
      record.status = 'INVALID_TASK';
      record.note = 'tests already pass at base commit';
      record.pre = pre;
      return record;
    }
    if (pre.noTestsFound) {
      record.status = 'INVALID_TASK';
      record.note = 'no test files matched at base state — task proves nothing';
      record.pre = pre;
      return record;
    }
    if (pre.total === 0 && !pre.collectionError) {
      // Zero assertions with no identifiable collection error. Could be an
      // empty suite, a runner misconfiguration, or a pattern that silently
      // matched nothing. Refused rather than graded: an unexplained red is not
      // evidence the task is sound.
      record.status = 'INVALID_SETUP';
      record.note =
        'zero assertions at base state with no collection error — cannot ' +
        'establish the suite is red for the right reason';
      record.pre = pre;
      return record;
    }
    if (pre.harnessError && !pre.collectionError) {
      record.status = 'INVALID_SETUP';
      record.note = 'tests did not run at base state';
      record.pre = pre;
      return record;
    }

    record.pre = {
      passed: pre.passed,
      failed: pre.failed,
      total: pre.total,
      // Which kind of red this was. A collection error is legitimate when the
      // fix commit creates the module under test — but it should be visible in
      // the record rather than inferred from a zero.
      redVia: pre.collectionError ? 'collection-error' : 'failing-assertions',
    };

    if (dryRun) {
      record.status = 'DRY_RUN';
      return record;
    }

    const transcriptPath = path.join(outDir, 'transcripts', `${runId}.jsonl`);
    await mkdir(path.dirname(transcriptPath), { recursive: true });

    // Experiment A holds the scaffold fixed (pi) and varies the model.
    // Experiment B holds the model fixed and varies this.
    const agent =
      scaffold === 'pi'
        ? await runPiAgent({
            dest: worktree,
            prompt: task.prompt,
            modelId: model,
            transcriptPath,
            maxTurns,
          })
        : await runAgent({
            dest: worktree,
            prompt: task.prompt,
            model,
            transcriptPath,
          });

    const post = await runTests({
      dest: worktree,
      workspace: task.workspace,
      testFiles: task.test_files,
      runner,
    });

    const tampered = await testFilesTampered({
      dest: worktree,
      fixCommit: task.source.fix_commit,
      testFiles: task.test_files,
    });

    record.agent = {
      costUsd: agent.costUsd,
      usage: agent.usage,
      numTurns: agent.numTurns,
      durationMs: agent.durationMs,
      wallClockMs: agent.wallClockMs,
      terminalReason: agent.terminalReason,
      apiErrorStatus: agent.apiErrorStatus,
      permissionDenials: agent.permissionDenials,
      // Per-model spend. `usage` describes the main model only, while
      // `costUsd` includes auxiliary calls (background summarisation runs on a
      // small model), so without this the two cannot be reconciled — it was the
      // unexplained residual when validating the cost model.
      modelUsage: agent.modelUsage,
      toolCallCount: agent.toolCalls.length,
      // Whether the model descriptor came from Pi's registry or was synthesised
      // from the pricing catalogue. A synthesised descriptor has no compat flags,
      // so a failure could be plumbing rather than capability.
      // Attempts to touch anything outside the worktree. Was returned by the
      // runner but dropped here, so the record read `undefined` and the guard
      // could not be audited from results alone.
      sandboxEscapeAttempts: agent.sandboxEscapeAttempts ?? [],
      modelSource: agent.modelSource ?? null,
      compatKnown: agent.compatKnown ?? null,
      toolCounts: agent.toolCalls.reduce((acc, c) => {
        acc[c.name] = (acc[c.name] ?? 0) + 1;
        return acc;
      }, {}),
    };

    record.post = {
      passed: post.passed,
      failed: post.failed,
      total: post.total,
      harnessError: post.harnessError,
      failures: post.failures?.slice(0, 5) ?? [],
    };

    record.testFilesTampered = tampered;

    // `git status` reports the applied test files as modified, because they
    // are — relative to the base commit. Counting them as work the agent did
    // inflates every blast-radius number by exactly the number of test files.
    // (Found by the first real run, which reported "2 files changed" for a
    // one-line fix.)
    const allChanged = await changedFiles({ dest: worktree });
    record.changedFiles = allChanged.filter((f) => !task.test_files.includes(f));

    // Files that are neither the applied tests nor where the fix was expected.
    // Sometimes correct (a repo convention like a changelog entry), sometimes
    // collateral. Either way it should not hide inside a total.
    const expected = task._expected_source_files ?? [];
    record.extraneousFiles = record.changedFiles.filter(
      (f) => !expected.includes(f)
    );

    record.diffStat = await diffStat({ dest: worktree });

    record.process = processSignals({
      toolCalls: agent.toolCalls,
      task,
      testsPassed: post.ok,
      resultText: agent.resultText,
    });

    // Tampering is not a pass, whatever the suite says.
    // A run stopped by the turn cap did not fail the task — it ran out of
    // budget. Folding the two together reports a harness parameter as a model
    // limitation, and the cap was binding on ~40% of runs when this was added.
    const hitCap = agent.terminalReason === 'max_turns';
    if (tampered.length) record.status = 'TAMPERED';
    else if (post.harnessError) record.status = 'BROKE_BUILD';
    else if (post.ok) record.status = hitCap ? 'PASS_AT_CAP' : 'PASS';
    else record.status = hitCap ? 'INCOMPLETE_AT_CAP' : 'FAIL';

    return record;
  } catch (err) {
    record.status = 'ERROR';
    record.error = String(err.message ?? err);
    return record;
  } finally {
    await removeWorktree({ repo, dest: worktree });
  }
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);
const repo = args.repo && path.resolve(args.repo);
if (!repo || !existsSync(repo)) {
  console.error('usage: run.mjs --repo <path-to-source-repo> [--models a,b] [--trials 3]');
  process.exit(1);
}

const scaffold = String(args.scaffold ?? 'claude-code');
if (!['pi', 'claude-code'].includes(scaffold)) {
  console.error(`unknown scaffold "${scaffold}" — expected pi or claude-code`);
  process.exit(1);
}

const models = String(
  args.models ?? (scaffold === 'pi' ? 'deepseek/deepseek-v4-flash' : 'sonnet')
)
  .split(',')
  .map((s) => s.trim());

// A provider-qualified id sent to the Claude Code path produces a 404 that
// records as a normal FAIL — zero tools, zero cost, and a result that looks
// like the model simply could not do the task. Caught here instead.
const misrouted = models.filter((m) => scaffold === 'claude-code' && m.includes('/'));
if (misrouted.length) {
  console.error(
    `Scaffold "claude-code" cannot drive ${misrouted.join(', ')}.\n` +
      `It runs Anthropic models only — pass --scaffold pi for OpenRouter ids.`
  );
  process.exit(1);
}
const trials = Number(args.trials ?? 3);
const maxTurns = Number(args['max-turns'] ?? 120);
const tasks = await loadTasks(path.resolve(args.tasks ?? 'tasks'), args.only);

if (!tasks.length) {
  console.error('No runnable tasks. Drafts are skipped until their prompts are rewritten.');
  process.exit(1);
}

LINK_DIRS = await detectLinkDirs(repo);

// Refuse a repository whose test runner cannot be read, rather than running
// every task and reporting them all as failures.
const unsupported = [];
for (const w of [...new Set(tasks.map((t) => t.workspace))]) {
  const r = await detectRunner({ repo, workspace: w });
  RUNNERS.set(w, r);
  if (!r) unsupported.push(`workspace "${w}": no test runner found`);
  else if (r.runner !== 'vitest') unsupported.push(`workspace "${w}": ${r.runner} not yet parseable`);
}
if (unsupported.length) {
  console.error(`Cannot run against ${path.basename(repo)}:`);
  for (const u of unsupported) console.error(`  ${u}`);
  console.error('\nOnly vitest result parsing is implemented. Refusing rather than guessing.');
  process.exit(1);
}
console.log(`Detected: ${LINK_DIRS.length} workspace dir(s), runner ${RUNNERS.get(tasks[0].workspace).runner}`);

const outDir = path.resolve('results', stamp());
await mkdir(outDir, { recursive: true });

console.log(
  `${tasks.length} task(s) × ${models.length} model(s) × ${trials} trial(s) via ${scaffold} ` +
    `= ${tasks.length * models.length * trials} runs`
);
console.log(`Results: ${outDir}\n`);

const records = [];
for (const task of tasks) {
  for (const model of models) {
    for (let trial = 1; trial <= trials; trial++) {
      process.stdout.write(`${task.id} ${scaffold}/${model} t${trial} … `);
      const record = await runOne({
        repo,
        task,
        model,
        trial,
        outDir,
        dryRun: Boolean(args['dry-run']),
        scaffold,
      });
      records.push(record);

      const cost = record.agent?.costUsd;
      console.log(
        `${record.status}${cost ? ` ($${cost.toFixed(3)})` : ''}` +
          `${record.note ? ` — ${record.note}` : ''}`
      );

      // Written after every run, so a crash or an interrupt keeps what it cost.
      await writeFile(
        path.join(outDir, 'runs.json'),
        `${JSON.stringify(records, null, 2)}\n`
      );
    }
  }
}

await writeFile(
  path.join(outDir, 'meta.json'),
  `${JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      repo: path.basename(repo),
      scaffold,
      maxTurns,
      models,
      trials,
      taskIds: tasks.map((t) => t.id),
      harnessVersion: '0.1.0',
    },
    null,
    2
  )}\n`
);

console.log(`\nDone. ${records.length} runs → ${outDir}`);
console.log('Analyze with: npm run report -- --results ' + outDir);
