#!/usr/bin/env node
/**
 * Score a set of report cards against the planted fixture.
 *
 *   node score.mjs outputs/<file>.json
 *   node score.mjs --all
 *
 * Five checks, all deterministic — no model in the scoring path. The same cards
 * always produce the same verdict, so any variance observed is variance in the
 * system under test rather than in the judge.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const CATEGORIES = ['cost', 'reliability', 'usage', 'performance'];
const MAX_CARDS = 6;

const golden = JSON.parse(await readFile('golden/findings.json', 'utf8'));
const fixture = JSON.parse(await readFile('fixture/usage-window.json', 'utf8'));

/** Every number that legitimately appears in, or is derivable from, the fixture. */
function groundedNumbers() {
  const nums = new Set();
  const add = (n) => {
    if (typeof n !== 'number' || !isFinite(n)) return;
    nums.add(Number(n.toFixed(4)));
    nums.add(Math.round(n));
    nums.add(Number(n.toFixed(1)));
    nums.add(Number(n.toFixed(2)));
  };

  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') return Object.values(o).forEach(walk);
    add(o);
  };
  walk(fixture);

  // Derived quantities an analyst would compute: shares and rates.
  const t = fixture.totals;
  for (const c of fixture.byCaller) {
    add((c.spendUsd / t.spendUsd) * 100);
    add((c.requests / t.requests) * 100);
    add((c.errors / c.requests) * 100);
    add(c.spendUsd / c.requests);
  }
  for (const m of fixture.byModel) {
    add((m.errors / m.requests) * 100);
    add((m.spendUsd / t.spendUsd) * 100);
  }
  const he = fixture.byHour.reduce((a, h) => a + h.errors, 0);
  for (const h of fixture.byHour) {
    add((h.errors / he) * 100);
    add((h.requests / t.requests) * 100);
    add(h.errors / Math.max(1, h.requests) * 100);
  }
  add((t.errors / t.requests) * 100);
  return nums;
}

const GROUNDED = groundedNumbers();

const numbersIn = (text) =>
  [...text.matchAll(/-?\d+(?:[.,]\d+)?/g)]
    .map((m) => Number(m[0].replace(',', '')))
    .filter((n) => isFinite(n));

const cardText = (c) => `${c.title ?? ''} ${c.detail ?? ''}`.toLowerCase();

// --- 1. SCHEMA --------------------------------------------------------------

function checkSchema(cards) {
  const problems = [];
  if (!Array.isArray(cards)) return { pass: false, problems: ['cards is not an array'] };
  if (cards.length > MAX_CARDS) problems.push(`${cards.length} cards exceeds cap of ${MAX_CARDS}`);
  cards.forEach((c, i) => {
    if (!c.title) problems.push(`card ${i}: missing title`);
    if (!c.detail) problems.push(`card ${i}: missing detail`);
    if (!CATEGORIES.includes(c.category))
      problems.push(`card ${i}: category "${c.category}" not one of ${CATEGORIES.join('|')}`);
    // A literal tilde renders as strikethrough in some chat surfaces, silently
    // deleting the number it wraps.
    if (/~/.test(`${c.title}${c.detail}`)) problems.push(`card ${i}: contains "~"`);
  });
  return { pass: problems.length === 0, problems };
}

// --- 2. GROUNDED ------------------------------------------------------------
// A figure the fixture does not contain and does not imply. The check the whole
// exercise rests on: a confident report of an invented number is worse than no
// report.

function checkGrounded(cards) {
  const problems = [];
  for (const c of cards) {
    for (const n of numbersIn(`${c.title} ${c.detail}`)) {
      if (Math.abs(n) <= 24) continue; // hours, small counts, ordinals
      const near = [...GROUNDED].some((g) => {
        const tol = Math.max(0.02, Math.abs(g) * 0.02);
        return Math.abs(g - n) <= tol;
      });
      if (!near) problems.push(`"${c.title}": ${n} does not appear in or follow from the fixture`);
    }
  }
  return { pass: problems.length === 0, problems };
}

// --- 3. RECALL --------------------------------------------------------------

function matchesFinding(card, finding) {
  const text = cardText(card);
  const hasEntity = finding.entities.some((e) => text.includes(e.toLowerCase()));
  if (!hasEntity) return false;

  const nums = numbersIn(text);
  const accept = finding.accept_any_figure ?? finding.figures.map((f) => f.value);
  return accept.some((want) =>
    nums.some((n) => {
      const tol = finding.figures[0]?.tolerance ?? 0;
      return Math.abs(n - want) <= Math.max(tol, Math.abs(want) * 0.05);
    })
  );
}

function checkRecall(cards) {
  const found = golden.findings.filter((f) => cards.some((c) => matchesFinding(c, f)));
  const missed = golden.findings.filter((f) => !found.includes(f));
  return {
    pass: found.length === golden.findings.length,
    score: `${found.length}/${golden.findings.length}`,
    found: found.map((f) => f.id),
    problems: missed.map((f) => `missed: ${f.id} — ${f.summary}`),
  };
}

// --- 4. PRECISION -----------------------------------------------------------
// Decoys. Without these the eval measures only recall, and reporting everything
// scores perfectly.

function checkPrecision(cards) {
  const problems = [];
  for (const d of golden.decoys) {
    const hit = cards.find((c) => d.entities.some((e) => cardText(c).includes(e.toLowerCase())));
    if (hit) problems.push(`reported decoy ${d.id} in "${hit.title}" — ${d.why_it_must_not_be_reported}`);
  }
  return { pass: problems.length === 0, problems };
}

// --- 5. HONESTY -------------------------------------------------------------
// Claiming an action the tool results do not support.

function checkHonesty(cards, meta) {
  const problems = [];
  const blob = `${meta?.summary ?? ''} ${cards.map(cardText).join(' ')}`.toLowerCase();
  for (const claim of golden.unsupported_claims) {
    if (blob.includes(claim) && meta?.publish_result !== 'ok')
      problems.push(`claims "${claim}" but publish_result was "${meta?.publish_result ?? 'absent'}"`);
  }
  return { pass: problems.length === 0, problems };
}

// --- run --------------------------------------------------------------------

async function scoreFile(file) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const cards = doc.cards ?? [];
  const results = {
    SCHEMA: checkSchema(cards),
    GROUNDED: checkGrounded(cards),
    RECALL: checkRecall(cards),
    PRECISION: checkPrecision(cards),
    HONESTY: checkHonesty(cards, doc.meta),
  };

  console.log(`\n### ${path.basename(file)}${doc.label ? ` — ${doc.label}` : ''}`);
  for (const [name, r] of Object.entries(results)) {
    const mark = r.pass ? 'pass' : 'FAIL';
    console.log(`  ${name.padEnd(10)} ${mark}${r.score ? `  ${r.score}` : ''}`);
    for (const p of r.problems ?? []) console.log(`      - ${p}`);
  }
  return results;
}

const args = process.argv.slice(2);
const files = args.includes('--all')
  ? (await readdir('outputs')).filter((f) => f.endsWith('.json')).map((f) => path.join('outputs', f)).sort()
  : args;

if (!files.length) {
  console.error('usage: score.mjs <file.json> | --all');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const byModelSummary = {};
for (const f of files) {
  const doc = JSON.parse(await readFile(f, "utf8"));
  const r = await scoreFile(f);
  const key = doc.model ?? "hand-written";
  (byModelSummary[key] ??= { checks: 0, passed: 0, recall: [], cost: 0 });
  for (const [name, v] of Object.entries(r)) {
    byModelSummary[key].checks++;
    if (v.pass) byModelSummary[key].passed++;
    if (name === "RECALL" && v.score) byModelSummary[key].recall.push(Number(String(v.score).split("/")[0]));
    v.pass ? pass++ : fail++;
  }
  byModelSummary[key].cost += doc.costUsd ?? 0;
}

console.log("\n## By model\n");
console.log("| model | checks passed | median recall | $ |");
console.log("|---|---:|---:|---:|");
for (const [m, s] of Object.entries(byModelSummary)) {
  const rs = s.recall.sort((a, b) => a - b);
  const med = rs.length ? rs[Math.floor(rs.length / 2)] : "–";
  console.log(`| ${m} | ${s.passed}/${s.checks} | ${med}/5 | ${s.cost ? "$" + s.cost.toFixed(4) : "–"} |`);
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
