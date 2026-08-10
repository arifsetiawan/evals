import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from './util.mjs';

/**
 * Run a set of test files and return structured results.
 *
 * Scoring is deterministic: tests either pass or they don't. There is no model
 * in the scoring path, so re-scoring the same run always yields the same
 * verdict, and any variance in the results is variance in the agent rather
 * than in the judge.
 */
export async function runTests({ dest, workspace, testFiles, runner, timeoutMs = 300_000 }) {
  if (!runner) {
    return {
      ok: false, harnessError: true, noTestsFound: false, collectionError: false,
      passed: 0, failed: 0, total: 0, failures: [],
      error:
        `No test runner detected for workspace "${workspace}". Supported: vitest, jest, ` +
        `node --test. Refusing to guess — a wrong runner reports every task as failing.`,
    };
  }
  if (runner.runner !== 'vitest') {
    return {
      ok: false, harnessError: true, noTestsFound: false, collectionError: false,
      passed: 0, failed: 0, total: 0, failures: [],
      error:
        `Detected ${runner.runner}, but only vitest result parsing is implemented. ` +
        `The task would run and its results could not be read, so it is refused instead.`,
    };
  }
  // vitest resolves paths relative to --root, so strip the workspace prefix.
  const rel = workspace
    ? testFiles.filter((f) => f.startsWith(`${workspace}/`)).map((f) => f.slice(workspace.length + 1))
    : testFiles;

  if (!rel.length) {
    // Must carry the same shape as a real result. Returning a bare {ok:false}
    // left `total` and `harnessError` undefined, so every gate condition read
    // as falsy and the task was graded anyway — a suite with no runnable tests
    // would burn agent budget and land in the failure taxonomy as a legitimate
    // FAIL.
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      harnessError: true,
      noTestsFound: true,
      collectionError: false,
      passed: 0,
      failed: 0,
      total: 0,
      failures: [],
      error: `no test files under workspace "${workspace}"`,
    };
  }

  const outputFile = path.join(dest, `.vitest-result-${Date.now()}.json`);

  // `--config` resolves relative to `--root`, so a workspace-relative config
  // path becomes `worker/worker/vitest.config.ts` and the run dies at startup.
  // Absolute avoids it. This silently invalidated every worker task in the
  // first full matrix — 9 of 27 runs — and only surfaced because invalid setups
  // are reported rather than dropped.
  //
  // Which config, and whether there is one, comes from detection: a monorepo
  // may keep one at the root or one per workspace, and a single-package repo
  // has no workspace segment at all.
  const configPath =
    runner.config && runner.configDir !== null
      ? path.resolve(dest, runner.configDir, runner.config)
      : null;

  const r = await run(
    'npx',
    [
      'vitest',
      'run',
      ...(configPath ? ['--config', configPath] : []),
      ...(workspace ? ['--root', workspace] : []),
      '--reporter=json',
      `--outputFile=${outputFile}`,
      ...rel,
    ],
    { cwd: dest, timeoutMs }
  );

  let report = null;
  try {
    report = JSON.parse(await readFile(outputFile, 'utf8'));
  } catch {
    // vitest writes nothing when it fails to start — a compile error, a
    // missing import, a crashed worker. That is a real outcome, not a gap in
    // the harness, so it is recorded rather than retried.
  } finally {
    await rm(outputFile, { force: true });
  }

  // Why zero assertions? The answer decides whether a task is valid, and the
  // count alone cannot tell you:
  //
  //   collection-error — the suite imports something the fix commit creates, so
  //                      it cannot even load at base state. Legitimately red.
  //   no-tests-found   — nothing matched the pattern. The task proves nothing
  //                      and must not be graded.
  //
  // Both surface as {passed:0, failed:0, total:0} with a non-zero exit. Reading
  // the runner's own output is the only way to separate them.
  const blob = `${r.stdout}\n${r.stderr}`;

  // Read the report, not the console. With `--reporter=json --outputFile`,
  // vitest writes a collection failure into neither stdout nor stderr — stdout
  // carries only "JSON report written to …" and stderr is empty. A regex over
  // the console output can never match, which silently reclassified a valid
  // task as an unexplained red and rejected it on every trial.
  //
  // The report distinguishes the two cases cleanly:
  //   testResults present, zero assertions → a suite was found and failed to
  //                                          load. Collection error.
  //   testResults empty                    → nothing matched the pattern.
  const suitesAttempted = Array.isArray(report?.testResults) ? report.testResults.length : 0;
  const assertionsSeen = (report?.numTotalTests ?? 0) > 0;

  const noTestsFound = report
    ? suitesAttempted === 0 && !assertionsSeen
    : /no test files found/i.test(blob);

  const collectionError = report
    ? suitesAttempted > 0 && !assertionsSeen && report.success === false
    : /(failed to load|cannot find module|error during collection|unhandled error|failed to resolve import)/i.test(
        blob
      );

  if (!report) {
    return {
      ok: false,
      exitCode: r.code,
      timedOut: r.timedOut,
      harnessError: true,
      noTestsFound,
      collectionError,
      passed: 0,
      failed: 0,
      total: 0,
      failures: [],
      stderr: r.stderr.slice(-4000),
      stdout: r.stdout.slice(-4000),
    };
  }

  const assertions = (report.testResults ?? []).flatMap(
    (suite) => suite.assertionResults ?? []
  );

  const failures = assertions
    .filter((a) => a.status === 'failed')
    .map((a) => ({
      name: a.fullName ?? a.title,
      messages: (a.failureMessages ?? []).map((m) => m.slice(0, 2000)),
    }));

  return {
    ok: r.code === 0,
    exitCode: r.code,
    timedOut: r.timedOut,
    harnessError: false,
    noTestsFound,
    collectionError,
    passed: assertions.filter((a) => a.status === 'passed').length,
    failed: failures.length,
    total: assertions.length,
    failures,
    durationMs: report.duration ?? null,
  };
}
