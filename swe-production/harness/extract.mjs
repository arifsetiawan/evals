#!/usr/bin/env node
/**
 * Turn a bugfix commit into a task definition.
 *
 *   node harness/extract.mjs --repo <path> --commit <sha> [--out tasks/]
 *   node harness/extract.mjs --repo <path> --candidates [--limit 40]
 *
 * `--candidates` lists commits that could become tasks: those that changed both
 * test files and source files. That is the property the whole construction
 * depends on — the commit carries the tests that describe the behavior it
 * added, so the tests can be applied without the fix.
 *
 * Extraction produces a DRAFT. The prompt it writes is derived from the commit
 * subject, which usually describes the fix rather than the symptom, so it leaks
 * the answer. Every task must have its prompt rewritten by hand before it is
 * used. Tasks are emitted with `"draft": true` and the runner refuses them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run, runOrThrow } from './lib/util.mjs';
import { detectLinkDirs } from './lib/detect.mjs';
import {
  commitBody,
  commitSubject,
  filesInCommit,
  resolveParent,
} from './lib/repo.mjs';

const TEST_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED = /^(CHANGELOG\.md|package-lock\.json|.*\.snap)$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Which workspace a file belongs to.
 *
 * Taking the first path segment assumes a monorepo. In a single-package
 * repository every top-level directory then looks like its own workspace, and
 * every commit is flagged as spanning several — so nothing is extractable at
 * all. Matched against the repository's declared workspaces instead, longest
 * first, falling back to the repository root.
 */
let WORKSPACES = [''];
function workspaceOf(file) {
  const match = WORKSPACES
    .filter((w) => w && file.startsWith(`${w}/`))
    .sort((a, b) => b.length - a.length)[0];
  return match ?? '';
}

function categorize(subject, sourceFiles) {
  const s = subject.toLowerCase();
  if (/^fix|bug|regress/.test(s)) return 'bugfix';
  if (/^feat|add /.test(s)) return 'feature';
  if (/^refactor|rename|move/.test(s)) return 'refactor';
  return 'other';
}

function difficulty(sourceFiles, testFiles) {
  const touched = sourceFiles.length;
  if (touched <= 1 && testFiles.length <= 1) return 'easy';
  if (touched <= 3) return 'medium';
  return 'hard';
}

async function listCandidates({ repo, limit }) {
  const r = await runOrThrow(
    'git',
    ['log', '--format=%H%x09%s', `-${limit}`],
    { cwd: repo }
  );

  const rows = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [sha, subject] = line.split('\t');
    const files = (await filesInCommit({ repo, commit: sha })).filter(
      (f) => !IGNORED.test(path.basename(f))
    );
    const tests = files.filter((f) => TEST_PATTERN.test(f));
    const source = files.filter((f) => !TEST_PATTERN.test(f));
    if (!tests.length || !source.length) continue;

    // A task needs its tests and its fix in the same workspace, otherwise the
    // test command has to span workspaces and pass/fail stops being clean.
    const workspaces = new Set(files.map(workspaceOf));
    rows.push({
      sha: sha.slice(0, 8),
      subject,
      tests: tests.length,
      source: source.length,
      workspaces: [...workspaces].join(','),
      singleWorkspace: workspaces.size === 1,
    });
  }
  return rows;
}

async function extract({ repo, commit, outDir }) {
  const subject = await commitSubject({ repo, commit });
  const body = await commitBody({ repo, commit });
  const parent = await resolveParent({ repo, commit });

  const files = (await filesInCommit({ repo, commit })).filter(
    (f) => !IGNORED.test(path.basename(f))
  );
  const testFiles = files.filter((f) => TEST_PATTERN.test(f));
  const sourceFiles = files.filter((f) => !TEST_PATTERN.test(f));

  if (!testFiles.length) {
    throw new Error(`${commit} changes no test files — cannot build a task`);
  }
  if (!sourceFiles.length) {
    throw new Error(`${commit} changes only tests — nothing for an agent to fix`);
  }

  const workspaces = [...new Set(testFiles.map(workspaceOf))];
  if (workspaces.length > 1) {
    throw new Error(
      `${commit} has tests in multiple workspaces (${workspaces.join(', ')}); ` +
        `split it or skip it`
    );
  }

  const id = workspaces[0] ? `${workspaces[0]}-${commit.slice(0, 8)}` : `case-${commit.slice(0, 8)}`;

  const task = {
    id,
    draft: true,
    _instructions:
      'Rewrite `prompt` as a bug report a developer would actually file: the ' +
      'observed symptom, not the fix. The generated text below is the commit ' +
      'subject and leaks the answer. Then delete this field and set draft:false.',

    source: {
      repo: path.basename(repo),
      fix_commit: commit,
      base_commit: parent,
      subject,
      body: body || null,
    },

    prompt: subject,

    workspace: workspaces[0],
    test_files: testFiles,
    // Recorded for analysis only. The agent is never told these — whether it
    // finds the right file is one of the things being measured.
    _expected_source_files: sourceFiles,

    category: categorize(subject, sourceFiles),
    difficulty: difficulty(sourceFiles, testFiles),
    tags: [
      sourceFiles.length > 1 ? 'multi-file' : 'single-file',
      files.some((f) => f.endsWith('.prisma') || f.includes('migration'))
        ? 'schema'
        : null,
    ].filter(Boolean),
  };

  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, `${id}.json`);
  await writeFile(dest, `${JSON.stringify(task, null, 2)}\n`);
  return dest;
}

const args = parseArgs(process.argv);
const repo = args.repo && path.resolve(args.repo);

if (!repo) {
  console.error(
    'usage:\n' +
      '  extract.mjs --repo <path> --candidates [--limit 40]\n' +
      '  extract.mjs --repo <path> --commit <sha> [--out tasks/]'
  );
  process.exit(1);
}

WORKSPACES = await detectLinkDirs(repo);

if (args.candidates) {
  const rows = await listCandidates({ repo, limit: Number(args.limit ?? 40) });
  if (!rows.length) {
    console.log('No commits changed both tests and source in that range.');
  } else {
    console.log(
      `${rows.length} candidate commit(s) — those changing both tests and source:\n`
    );
    for (const r of rows) {
      const flag = r.singleWorkspace ? '  ' : '! ';
      console.log(
        `${flag}${r.sha}  tests:${String(r.tests).padEnd(2)} src:${String(
          r.source
        ).padEnd(3)} [${r.workspaces}]  ${r.subject.slice(0, 72)}`
      );
    }
    console.log(
      '\n! = tests span multiple workspaces; split or skip.\n' +
        'Extract one with: --commit <sha>'
    );
  }
} else if (args.commit) {
  const dest = await extract({
    repo,
    commit: args.commit,
    outDir: path.resolve(args.out ?? 'tasks'),
  });
  console.log(`Wrote ${dest}`);
  console.log(
    'DRAFT — rewrite the prompt so it describes the symptom, not the fix, ' +
      'then set draft:false.'
  );
} else {
  console.error('Need --candidates or --commit <sha>');
  process.exit(1);
}
