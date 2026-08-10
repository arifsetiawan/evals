#!/usr/bin/env node
/**
 * Measure what each fixture case actually costs to fix, and write that into
 * ground truth.
 *
 * Difficulty is not asserted anywhere in this eval. It is whatever the standard
 * tooling does when pointed at the case:
 *
 *   npm audit fix          clears it → the easy baseline
 *   npm audit fix --force  clears it → needs a breaking change
 *   neither                          → needs an override, or has no fix at all
 *
 * An earlier version declared four tiers by hand. `npm audit fix` resolved none
 * of them, two were byte-identical, and the "easy baseline" was as hard as
 * everything else. Running the tooling is the only way to know.
 *
 * The registry also moves. A case that has no fix today may have one tomorrow,
 * and a negative control that has quietly become solvable would mark every
 * model wrong for answering correctly. Re-run this before trusting any result.
 */

import { readFile, writeFile, rm, cp } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(await readFile(path.join(here, 'ground-truth.json'), 'utf8'));

const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8' });

function auditOf(dir) {
  // `npm audit` exits non-zero when it finds anything; the JSON body is valid.
  const out = npm(['audit', '--json'], dir).stdout;
  try {
    const a = JSON.parse(out);
    const vulns = Object.values(a.vulnerabilities ?? {});
    return {
      total: a.metadata?.vulnerabilities?.total ?? 0,
      anyFixable: vulns.some((v) => v.fixAvailable && v.fixAvailable !== false),
      names: vulns.map((v) => v.name),
    };
  } catch {
    return { total: -1, anyFixable: false, names: [] };
  }
}

/** Run one remediation strategy against a throwaway copy. */
function tryStrategy(caseDir, args) {
  const tmp = path.join(os.tmpdir(), `dep-rem-${Math.abs(Date.now() % 1e9)}-${args.join('')}`);
  spawnSync('cp', ['-r', caseDir, tmp]);
  npm(['install', '--silent', '--no-audit', '--no-fund'], tmp);
  npm(args, tmp);
  const after = auditOf(tmp);
  spawnSync('rm', ['-rf', tmp]);
  return after.total === 0;
}

const rows = [];
for (const id of readdirSync(path.join(here, 'cases'))) {
  const dir = path.join(here, 'cases', id);
  npm(['install', '--silent', '--no-audit', '--no-fund'], dir);
  const before = auditOf(dir);

  const plainFix = before.total > 0 && tryStrategy(dir, ['audit', 'fix', '--silent', '--no-fund']);
  const forceFix =
    before.total > 0 && !plainFix &&
    tryStrategy(dir, ['audit', 'fix', '--force', '--silent', '--no-fund']);

  const difficulty = before.total === 0
    ? 'INVALID — no advisory'
    : plainFix
      ? 'baseline (npm audit fix)'
      : forceFix
        ? 'breaking (npm audit fix --force)'
        : before.anyFixable
          ? 'override required'
          // npm reporting no fix means no fix ON THE NPM REGISTRY. It is not
          // evidence that none exists — one case labelled this way was solved on
          // its first run by a model that found the maintainer's own CDN. Marking
          // a case genuinely unfixable requires confirming it by hand and setting
          // `confirmedUnfixable` in ground-truth.json.
          : 'no fix on the npm registry (not confirmed unfixable)';

  rows.push({ id, advisories: before.total, packages: before.names, plainFix, forceFix, difficulty });
}

console.log('| case | advisories | audit fix | + --force | measured difficulty |');
console.log('|---|---:|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.id} | ${r.advisories} (${r.packages.join(', ')}) | ${r.plainFix ? 'clears' : 'no'} | ` +
      `${r.forceFix ? 'clears' : 'no'} | **${r.difficulty}** |`
  );
}

truth.measured_at = new Date().toISOString();
truth.measured = Object.fromEntries(
  rows.map((r) => [
    r.id,
    { advisories: r.advisories, packages: r.packages, clearedByAuditFix: r.plainFix, clearedByForce: r.forceFix, difficulty: r.difficulty },
  ])
);
await writeFile(path.join(here, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

const invalid = rows.filter((r) => r.advisories <= 0);
const controls = rows.filter((r) => truth.cases?.[r.id]?.confirmedUnfixable === true);
console.log(`\n${rows.length} cases measured. ${controls.length} confirmed negative control(s).`);
if (invalid.length) {
  console.log(`${invalid.length} case(s) report no advisory — the registry moved. Rebuild before running.`);
  process.exit(1);
}
if (!controls.length) {
  console.log(
    'No confirmed negative control. Without a case whose correct answer is failure, a clean\n' +
      'sweep cannot be distinguished from a scorer that never fails anything. This is a known\n' +
      'gap, recorded in the README, not a reason to stop — but results are weaker for it.'
  );
}
