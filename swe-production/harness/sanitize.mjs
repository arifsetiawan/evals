#!/usr/bin/env node
/**
 * Derive a publishable, self-contained fixture from a task in a private repo.
 *
 *   node harness/sanitize.mjs --repo <path> --task tasks/<id>.json [--out fixtures/]
 *   node harness/sanitize.mjs --repo <path> --all
 *
 * The bug and its tests are real — taken from a real fix commit — but the
 * fixture carries no customer name, no document number, no product identity,
 * and no commit metadata. What survives is the logic and the test that
 * describes it.
 *
 * The deny scan runs **after** renaming and **fails the fixture** rather than
 * warning. Automated redaction that silently misses something is worse than
 * none, because it produces confidence rather than caution.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run, runOrThrow } from './lib/util.mjs';

// The populated deny list is deliberately not in the repository — see
// redaction.example.json. Failing loudly beats falling back to the template,
// which would run with placeholder terms and pass everything.
// Which rule file to use is a flag, because the terms to remove belong to the
// source repository, not to this tool. Point it at a different codebase and it
// needs a different list — one company's product names are another's noise.
const rulesArg = process.argv.includes('--redaction')
  ? process.argv[process.argv.indexOf('--redaction') + 1]
  : null;
const rulesPath = rulesArg
  ? new URL(`file://${path.resolve(rulesArg)}`)
  : new URL('./redaction.json', import.meta.url);

let rules;
try {
  rules = JSON.parse(await readFile(rulesPath, 'utf8'));
} catch {
  console.error(
    'harness/redaction.json not found.\n\n' +
      `No rule file at ${rulesPath.pathname}.\n\n` +
      'Copy redaction.example.json, fill in the names, systems,\n' +
      'and identifier patterns specific to your codebase. The real file is gitignored:\n' +
      'a populated deny list indexes exactly what you are trying to remove.\n\n' +
      'Refusing to run rather than falling back to the template, which would match\n' +
      'nothing and mark every fixture clean.'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

/**
 * Drop comment blocks and lines that narrate a real incident.
 *
 * Renaming these is not enough. "Hit live on <customer>'s <doc>, Jul 2026"
 * with the customer renamed still tells a reader that a real business was
 * affected, when, and how — which the fixture does not need in order to
 * describe the bug.
 */
function stripIncidentComments(text) {
  const markers = rules.strip_comment_markers.map((m) => m.toLowerCase());
  const hasMarker = (s) => markers.some((m) => s.toLowerCase().includes(m));
  const isComment = (s) => /^\s*(\/\/|\*)/.test(s);

  /**
   * Incident narration runs across lines, so dropping only the matching line
   * leaves the rest of its sentence dangling — the first pass left
   * "(57 kg entered for 5.7 kg) that could only be fixed by…" behind, with the
   * subject removed. Continuation lines are dropped with the line that starts
   * the sentence: a comment line is a continuation when its first word is not
   * capitalised and it does not open a new sentence.
   */
  const dropWithContinuations = (lines) => {
    const out = [];
    let dropping = false;
    for (const line of lines) {
      if (!isComment(line)) { dropping = false; out.push(line); continue; }

      const body = line.replace(/^\s*(\/\/|\*)\s?/, '').trim();
      if (hasMarker(line)) { dropping = true; continue; }

      if (dropping) {
        const startsNewSentence = /^[A-Z(]/.test(body) && !/^\(\d/.test(body);
        const isBlank = body === '';
        if (isBlank) { dropping = false; out.push(line); continue; }
        if (!startsNewSentence || /^\(/.test(body)) continue; // still the same sentence
        dropping = false;
      }
      out.push(line);
    }
    return out;
  };

  // Block comments
  text = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    hasMarker(block) ? dropWithContinuations(block.split('\n')).join('\n') : block
  );

  // Line comments
  return dropWithContinuations(text.split('\n')).join('\n');
}

/**
 * Remove an entire comment block when any line in it is product or competitive
 * reasoning.
 *
 * Line-level removal is wrong for this category. Stripping the one line naming
 * a competitor left "rather than <renamed>'s approach (a merchant-configured
 * sequence of fixed-delay, mostly-static" followed by an unrelated sentence:
 * broken prose that still carried the comparison. The unit of meaning is the
 * block, so the block is the unit of removal.
 */
function stripStrategyBlocks(text) {
  const markers = (rules.strip_comment_blocks ?? []).map((m) => m.toLowerCase());
  if (!markers.length) return text;
  const hit = (s) => markers.some((m) => s.toLowerCase().includes(m));

  text = text.replace(/\/\*[\s\S]*?\*\//g, (b) => (hit(b) ? '' : b));

  const out = [];
  let run = [];
  const flush = () => {
    if (run.length && !hit(run.join('\n'))) out.push(...run);
    run = [];
  };
  for (const ln of text.split('\n')) {
    if (/^\s*\/\//.test(ln)) run.push(ln);
    else { flush(); out.push(ln); }
  }
  flush();
  return out.join('\n');
}

function redact(text) {
  let out = stripStrategyBlocks(text);
  out = stripIncidentComments(out);
  for (const { from, to } of rules.rename) out = out.split(from).join(to);
  for (const { pattern, to } of rules.redact_patterns)
    out = out.replace(new RegExp(pattern, 'g'), to);
  return out;
}

/**
 * Hard gate. Returns the offending terms; empty means clean.
 *
 * Plain alphanumeric terms match on word boundaries — a bare substring scan
 * blocked a fixture because "tare" appears inside "textarea". Terms containing
 * punctuation — an email domain, an IP prefix, a document-number stem — stay
 * substring, since those are fragments by design and boundaries would defeat
 * them.
 *
 * Note this makes the check *more precise*, not more permissive: "tare" as a
 * word still blocks.
 */
function denyScan(text) {
  const lower = text.toLowerCase();
  return rules.deny.filter((d) => {
    const term = d.toLowerCase();
    if (/^[a-z0-9]+$/.test(term)) {
      return new RegExp(`\\b${term}\\b`, 'i').test(lower);
    }
    return lower.includes(term);
  });
}

/**
 * Flatten a repo path to a fixture filename that stays unique.
 *
 * Basename alone collides: two `route.ts` files in different API directories
 * flattened to one, and the second silently overwrote the first — the fixture
 * shipped a source file short, with no error. Prefixing the parent directory
 * disambiguates without reproducing the private repo's directory tree.
 */
function fixtureName(repoPath) {
  const parts = repoPath.split('/').filter(Boolean);
  const base = parts.pop();
  const parent = parts.pop();
  const looksGeneric = /^(route|index|page|handler)\.[jt]sx?$/.test(base);
  return looksGeneric && parent ? `${parent}__${base}` : base;
}

async function fileAt({ repo, commit, file }) {
  const r = await run('git', ['show', `${commit}:${file}`], { cwd: repo });
  return r.code === 0 ? r.stdout : null;
}

async function sanitizeTask({ repo, taskFile, outRoot }) {
  const task = JSON.parse(await readFile(taskFile, 'utf8'));
  // The fixture is identified by content, never by the private repo's SHA.
  const slug = path.basename(taskFile, '.json').replace(/^[a-z]+-/, 'case-');
  const dest = path.join(outRoot, slug);

  const sources = task._expected_source_files ?? [];
  const tests = task.test_files ?? [];

  const violations = [];
  const written = [];
  const seen = new Map();       // fixture rel path -> originating repo path
  const importMap = new Map();  // original basename (no ext) -> fixture basename (no ext)

  const claim = (rel, origin) => {
    if (seen.has(rel) && seen.get(rel) !== origin) {
      violations.push(`name collision: ${seen.get(rel)} and ${origin} both map to ${rel}`);
      return false;
    }
    seen.set(rel, origin);
    return true;
  };

  // Source files at BASE state — pre-fix, which is what the agent must repair.
  for (const f of sources) {
    const raw = await fileAt({ repo, commit: task.source.base_commit, file: f });
    if (raw === null) {
      // A file created by the fix commit does not exist at base. That is normal
      // and the agent is expected to create it.
      continue;
    }
    const clean = redact(raw);
    const bad = denyScan(clean);
    if (bad.length) { violations.push(`${f}: ${bad.join(', ')}`); continue; }

    const name = fixtureName(f);
    const rel = path.join('src', name);
    if (!claim(rel, f)) continue;
    importMap.set(
      path.basename(f).replace(/\.[jt]sx?$/, ''),
      name.replace(/\.[jt]sx?$/, '')
    );
    written.push({ rel, body: clean });
  }

  // Test files from the FIX commit — these describe the repaired behavior.
  for (const f of tests) {
    const raw = await fileAt({ repo, commit: task.source.fix_commit, file: f });
    if (raw === null) { violations.push(`${f}: missing at fix commit`); continue; }
    let clean = redact(raw);
    // Rewrite imports onto the flattened layout, following any rename applied
    // above so a disambiguated source file is still resolvable.
    clean = clean.replace(
      /from\s+['"](?:\.\.?\/)+(?:[\w./-]*\/)?([\w.-]+)['"]/g,
      (_m, base) => `from '../src/${importMap.get(base) ?? base}'`
    );
    const bad = denyScan(clean);
    if (bad.length) { violations.push(`${f}: ${bad.join(', ')}`); continue; }

    const rel = path.join('test', fixtureName(f));
    if (!claim(rel, f)) continue;
    written.push({ rel, body: clean });
  }

  if (violations.length) {
    return { slug, ok: false, violations };
  }
  if (!written.some((w) => w.rel.startsWith('test'))) {
    return { slug, ok: false, violations: ['no test file survived'] };
  }

  await mkdir(path.join(dest, 'src'), { recursive: true });
  await mkdir(path.join(dest, 'test'), { recursive: true });
  for (const w of written) await writeFile(path.join(dest, w.rel), w.body);

  await writeFile(
    path.join(dest, 'package.json'),
    `${JSON.stringify(
      {
        name: slug,
        private: true,
        type: 'module',
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^4.0.0' },
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    path.join(dest, 'TASK.md'),
    `# ${slug}\n\n` +
      `${redact(task.prompt)}\n\n` +
      `## How this fixture was made\n\n` +
      `Derived from a real bugfix commit in a private repository. The source is at its\n` +
      `pre-fix state; the tests describe the fixed behavior and fail until the bug is\n` +
      `repaired. Customer names, document numbers, identifiers and incident notes were\n` +
      `removed mechanically (\`harness/sanitize.mjs\`), and the fixture is not written at\n` +
      `all if any denied term survives that pass.\n\n` +
      `Category: ${task.category} · Difficulty: ${task.difficulty}\n`
  );

  return { slug, ok: true, files: written.map((w) => w.rel) };
}

// --- run --------------------------------------------------------------------

const args = parseArgs(process.argv);
const repo = args.repo && path.resolve(args.repo);
const outRoot = path.resolve(args.out ?? 'fixtures');

if (!repo || !existsSync(repo)) {
  console.error('usage: sanitize.mjs --repo <path> (--task tasks/<id>.json | --all)');
  process.exit(1);
}

const taskFiles = args.all
  ? (await readdir('tasks')).filter((f) => f.endsWith('.json')).map((f) => path.join('tasks', f)).sort()
  : [args.task].filter(Boolean);

if (!taskFiles.length) {
  console.error('Need --task <file> or --all');
  process.exit(1);
}

let ok = 0;
let blocked = 0;
for (const tf of taskFiles) {
  const r = await sanitizeTask({ repo, taskFile: tf, outRoot });
  if (r.ok) {
    ok++;
    console.log(`ok      ${r.slug}  (${r.files.join(', ')})`);
  } else {
    blocked++;
    console.log(`BLOCKED ${r.slug}`);
    for (const v of r.violations) console.log(`          ${v}`);
  }
}

console.log(`\n${ok} fixture(s) written to ${outRoot}, ${blocked} blocked.`);
if (blocked) {
  console.log(
    'Blocked fixtures were not written. Either the slice reaches into code that\n' +
      'cannot be published, or a denied term survived redaction. Review by hand —\n' +
      'do not loosen the deny list to make one pass.'
  );
}
