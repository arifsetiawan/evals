import { existsSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { run, runOrThrow } from './util.mjs';

/**
 * Every run gets its own git worktree pinned to the task's base commit.
 *
 * The pinning is the point: two models, or two trials of one model, are only
 * comparable when they start from byte-identical state. An eval that runs
 * against a moving branch cannot attribute a score change to the thing it
 * changed.
 */

export async function createWorktree({ repo, baseCommit, dest }) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });

  // Deleting a worktree directory does not unregister it. Git then refuses to
  // reuse the path — "missing but already registered worktree" — and the run
  // dies in setup, which is indistinguishable from a task failure unless you
  // read the error. Prune first so a stale registration cannot poison a rerun.
  await run('git', ['worktree', 'prune'], { cwd: repo });

  await runOrThrow('git', ['worktree', 'add', '--detach', dest, baseCommit], {
    cwd: repo,
  });

  return dest;
}

export async function removeWorktree({ repo, dest }) {
  await run('git', ['worktree', 'remove', '--force', dest], { cwd: repo });
  await rm(dest, { recursive: true, force: true });
}

/**
 * Link dependencies from the source checkout instead of installing per run.
 *
 * A fresh `npm install` per run would cost minutes and could resolve different
 * transitive versions on different days — an uncontrolled variable in a
 * measurement that is supposed to isolate the model. Linking makes every run
 * see the same dependency tree.
 */
export async function linkDependencies({ repo, dest, dirs }) {
  for (const dir of dirs) {
    const src = path.join(repo, dir, 'node_modules');
    if (!existsSync(src)) continue;
    const target = path.join(dest, dir, 'node_modules');
    if (existsSync(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(src, target, 'dir');
  }
}

/**
 * Copy the test files from the fix commit onto the base state.
 *
 * This is the FAIL_TO_PASS construction: the tests that describe the fixed
 * behavior exist, the fix itself does not. The agent has to write the fix.
 */
export async function applyTestFiles({ dest, fixCommit, testFiles }) {
  await runOrThrow('git', ['checkout', fixCommit, '--', ...testFiles], {
    cwd: dest,
  });
}

/** Files the agent touched, so we can tell fixing from cheating. */
export async function changedFiles({ dest }) {
  const r = await run('git', ['status', '--porcelain'], { cwd: dest });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function diffStat({ dest }) {
  const r = await run('git', ['diff', '--stat', 'HEAD'], { cwd: dest });
  return r.stdout.trim();
}

/**
 * Did the agent edit the tests it was supposed to satisfy?
 *
 * Weakening a failing assertion turns a red suite green without fixing
 * anything. A pass rate that counts those runs is measuring the wrong thing,
 * so this is checked on every run and reported separately rather than folded
 * into the score.
 */
export async function testFilesTampered({ dest, fixCommit, testFiles }) {
  const tampered = [];
  for (const file of testFiles) {
    const r = await run('git', ['diff', '--quiet', fixCommit, '--', file], {
      cwd: dest,
    });
    if (r.code !== 0) tampered.push(file);
  }
  return tampered;
}

export async function resolveParent({ repo, commit }) {
  const r = await runOrThrow('git', ['rev-parse', `${commit}^`], { cwd: repo });
  return r.stdout.trim();
}

export async function commitSubject({ repo, commit }) {
  const r = await runOrThrow('git', ['log', '-1', '--format=%s', commit], {
    cwd: repo,
  });
  return r.stdout.trim();
}

export async function commitBody({ repo, commit }) {
  const r = await runOrThrow('git', ['log', '-1', '--format=%b', commit], {
    cwd: repo,
  });
  return r.stdout.trim();
}

export async function filesInCommit({ repo, commit }) {
  const r = await runOrThrow(
    'git',
    ['show', '--name-only', '--format=', commit],
    { cwd: repo }
  );
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
