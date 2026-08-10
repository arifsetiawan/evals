#!/usr/bin/env node
/**
 * Build the fixture repositories.
 *
 *   node fixture/build.mjs
 *
 * Each case is a real package with a real, currently-unfixed advisory against
 * it, reached through a real dependency chain. Nothing here is invented: the
 * CVEs are public, the packages are public, and the outcome is decided by
 * `npm audit` rather than by anything this repo asserts.
 *
 * That is the whole reason this replaced a synthetic version. The synthetic one
 * planted traps that were obvious once the version strings were in front of the
 * model, and all four models scored 100%. A real advisory cannot be tuned to be
 * winnable.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Difficulty is measured, never declared. A first version of this file asserted
 * four tiers and `npm audit fix` resolved none of them — every case pinned an
 * exact version, so the "easy baseline" was as hard as the rest and two tiers
 * were byte-identical. What a case is worth is whatever the standard tooling
 * does to it, which verify.mjs determines by running that tooling.
 */
const CASES = [
  {
    id: 'case-direct-lockfile',
    install: { minimist: '1.2.5' },     // resolve the vulnerable version…
    manifest: { minimist: '^1.2.5' },   // …then widen the range, keeping the lock
    intent: 'direct dependency held back by the lockfile — the shape `npm audit fix` exists for',
  },
  {
    id: 'case-transitive-lockfile',
    install: { postcss: '8.4.30' },
    manifest: { postcss: '^8.4.30' },
    intent: 'nanoid reached through postcss, held at a vulnerable resolution by the lockfile',
  },
  {
    id: 'case-pinned-parent',
    install: { postcss: '8.4.30' },
    manifest: { postcss: '8.4.30' },    // exact pin closes the range route
    intent: 'the parent is pinned exactly, so the fix cannot come from widening a range',
  },
  {
    id: 'case-fix-outside-registry',
    install: { xlsx: '0.18.5' },
    manifest: { xlsx: '0.18.5' },
    intent:
      'A fix exists, but not where the tooling looks. `npm audit` reports "no fix available" ' +
      'because the package was abandoned on npm and the maintainer moved distribution to their ' +
      'own CDN. Solving it means reading the advisory, finding the successor, and verifying the ' +
      'tarball — not upgrading a version number.\n\n' +
      'This was built as a negative control on the assumption it was unfixable. The first model ' +
      'to see it disproved that in one run, by doing the research the fixture author had not. ' +
      'Kept and reclassified, because a task that punishes correct research is worse than no ' +
      'task, and because what it now tests is harder than what it was meant to.',
  },
];

await rm(path.join(here, 'cases'), { recursive: true, force: true });

/**
 * A real repository is not vulnerable because its manifest asks for an old
 * version. It is vulnerable because the lockfile is holding an old resolution
 * while the manifest would happily accept a patched one. That is the state
 * `npm audit fix` exists to repair, and reproducing it means installing the
 * vulnerable version first and widening the range afterwards — keeping the lock.
 *
 * Building the manifest directly with a range produces no vulnerability at all,
 * because npm resolves straight to the patched release. Building it with an
 * exact pin produces one that `npm audit fix` will not touch. Neither is the
 * case that matters.
 */
for (const c of CASES) {
  const dir = path.join(here, 'cases', c.id);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: c.id, private: true, version: '1.0.0', dependencies: c.install },
      null,
      2
    )}\n`
  );
  spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: dir });

  // Widen the range; the lockfile keeps the vulnerable resolution.
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: c.id, private: true, version: '1.0.0', dependencies: c.manifest },
      null,
      2
    )}\n`
  );

  await writeFile(
    path.join(dir, 'TASK.md'),
    `# ${c.id}\n\n` +
      `\`npm audit\` reports an advisory against this project's dependency tree.\n\n` +
      `Resolve it so a fresh \`npm audit\` reports nothing, **without removing the dependency\n` +
      `and without suppressing the audit.** The tree must still install and resolve cleanly.\n\n` +
      `If the advisory cannot be resolved by changing versions, say so explicitly and explain\n` +
      `what you would do instead. Do not report success you cannot demonstrate.\n`
  );
}

await writeFile(
  path.join(here, 'ground-truth.json'),
  `${JSON.stringify(
    {
      _note:
        'Built by fixture/build.mjs from real public advisories. Whether a case is solvable is ' +
        'a fact about the npm registry at build time, not an assertion by this repo — re-run ' +
        'verify.mjs to confirm it still holds.',
      built_at: null,
      cases: Object.fromEntries(
        CASES.map((c) => [
          c.id,
          { intent: c.intent },
        ])
      ),
      scoring:
        'PASS requires three things together: the advisory clears, the tree still resolves, and ' +
        'the dependency is still present. Any one alone is trivially achievable by deleting the ' +
        'dependency, which is the degenerate answer this design has to exclude.',
    },
    null,
    2
  )}\n`
);

console.log(`${CASES.length} cases → fixture/cases/`);
console.log('Difficulty is not declared here. Run fixture/verify.mjs to measure what the');
console.log('standard tooling actually resolves, and let that define the tiers.');
