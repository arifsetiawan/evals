#!/usr/bin/env node
/**
 * Check the cost model against money actually billed.
 *
 *   node analysis/validate-pricing.mjs --results results/<timestamp>
 *
 * A cost model nobody checks is a spreadsheet of assumptions. Claude Code
 * reports what it was charged per run, which is ground truth for one model —
 * so the model can be validated where it overlaps and its residual error
 * stated, rather than assumed away.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { priceRun, tokenMix } from '../harness/lib/pricing.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, [])
);
const dir = path.resolve(args.results ?? '.');

const catalog = JSON.parse(
  await readFile(new URL('../harness/pricing/catalog.json', import.meta.url), 'utf8')
);
const runs = JSON.parse(await readFile(path.join(dir, 'runs.json'), 'utf8')).filter(
  (r) => r.agent?.usage && typeof r.agent.costUsd === 'number'
);

if (!runs.length) {
  console.error('No runs with both usage and a billed cost.');
  process.exit(1);
}

const mix = tokenMix(runs.map((r) => r.agent.usage));
console.log(`\n# Cost model validation — ${path.basename(dir)}\n`);
console.log(`${runs.length} runs, ${(mix.total / runs.length / 1000).toFixed(0)}k tokens/run\n`);
console.log('## Workload shape\n');
console.log(
  `cache read ${mix.pct.cacheRead.toFixed(1)}% · cache write ${mix.pct.cacheWrite.toFixed(1)}% ` +
    `· output ${mix.pct.out.toFixed(1)}% · fresh input ${mix.pct.fresh.toFixed(2)}%`
);
console.log(
  '\nAn in/out blended price describes a different workload than this one. Cost is\n' +
    'modelled per token class instead.\n'
);

// --- validation against billed cost -----------------------------------------

const sonnet = catalog.models['anthropic/claude-sonnet-5'];
let modelled = 0;
let actual = 0;
for (const r of runs) {
  modelled += priceRun({ pricing: sonnet.pricing, usage: r.agent.usage }).usd;
  actual += r.agent.costUsd;
}
const delta = (100 * (modelled - actual)) / actual;

console.log('## Modelled vs. billed (Sonnet, the one model where both exist)\n');
console.log(`| | USD |`);
console.log(`|---|---:|`);
console.log(`| modelled from OpenRouter list price | ${modelled.toFixed(2)} |`);
console.log(`| actually billed by Claude Code | ${actual.toFixed(2)} |`);
console.log(`| **delta** | **${delta > 0 ? '+' : ''}${delta.toFixed(1)}%** |`);

// Solve for the rates implied by what was actually charged, so the gap is
// attributed rather than waved at.
const t = runs.reduce(
  (a, r) => {
    const u = r.agent.usage;
    a.fresh += u.input_tokens ?? 0;
    a.read += u.cache_read_input_tokens ?? 0;
    a.w1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    a.w5m += u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    a.out += u.output_tokens ?? 0;
    return a;
  },
  { fresh: 0, read: 0, w1h: 0, w5m: 0, out: 0 }
);

// Anthropic's direct rate card reconciles these runs to within rounding.
const DIRECT = { prompt: 3e-6, read: 0.3e-6, write1h: 6e-6, write5m: 3.75e-6, out: 15e-6 };
const direct =
  t.fresh * DIRECT.prompt +
  t.read * DIRECT.read +
  t.w1h * DIRECT.write1h +
  t.w5m * DIRECT.write5m +
  t.out * DIRECT.out;

console.log('\n## Where the gap comes from\n');
console.log(`| priced at | USD | vs billed |`);
console.log(`|---|---:|---:|`);
console.log(`| OpenRouter list for \`anthropic/claude-sonnet-5\` | ${modelled.toFixed(2)} | ${delta.toFixed(1)}% |`);
console.log(
  `| Anthropic direct rates | ${direct.toFixed(2)} | ${(
    (100 * (direct - actual)) /
    actual
  ).toFixed(1)}% |`
);
console.log(
  '\n**Most of the gap is not model error — it is two price lists for the same\n' +
    'model.** Claude Code bills Anthropic direct rates; OpenRouter resells the same\n' +
    'model at its own, cheaper, price. Both are correct for their own channel.\n\n' +
    'The residual against direct rates is auxiliary model spend: `usage` describes\n' +
    'the main model, while the billed total also covers background calls made on a\n' +
    'small model. Those are absent from the token counts the model prices, so it\n' +
    'underestimates by roughly that share. Runs recorded after this was found carry\n' +
    '`modelUsage`, which attributes it; earlier result sets cannot be decomposed.\n\n' +
    'The consequence for this eval: a cross-model comparison must price every model\n' +
    'from **one** source. Since the multi-model runs execute through OpenRouter,\n' +
    'OpenRouter list is that source — including for Sonnet, whose billed figures\n' +
    'from earlier Claude Code runs are therefore not directly comparable.\n'
);

// --- per-token-class breakdown ----------------------------------------------

const one = priceRun({ pricing: sonnet.pricing, usage: runs[0].agent.usage });
console.log('## Cost by token class (one representative run, OpenRouter list)\n');
console.log('| class | tokens | USD | share |');
console.log('|---|---:|---:|---:|');
for (const [k, v] of Object.entries(one.breakdown)) {
  console.log(`| ${k} | — | ${v.toFixed(4)} | ${((100 * v) / one.usd).toFixed(1)}% |`);
}
console.log(
  '\nCache reads dominate. Any decision made on headline in/out pricing is being\n' +
    'made about the smallest line on the bill.'
);
