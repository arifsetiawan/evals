#!/usr/bin/env node
/**
 * Snapshot pricing for the models under test.
 *
 *   node harness/pricing/fetch.mjs
 *
 * Prices drift. A cost model that re-fetches silently makes every past result
 * unreproducible — the same runs re-analysed next month would report different
 * money with no indication why. So the catalogue is pinned to a file, committed,
 * and stamped into each result set. Refreshing it is a deliberate act that shows
 * up in a diff.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = [
  'anthropic/claude-sonnet-5',
  'moonshotai/kimi-k3',
  'openai/gpt-5.6-terra',
  'z-ai/glm-5.2',
  'deepseek/deepseek-v4-pro',
  'openai/gpt-5.6-luna',
  'deepseek/deepseek-v4-flash',
  'google/gemini-3.6-flash',
];

const here = path.dirname(fileURLToPath(import.meta.url));

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) {
  console.error(`OpenRouter returned ${res.status}`);
  process.exit(1);
}
const { data } = await res.json();

const missing = MODELS.filter((id) => !data.some((m) => m.id === id));
if (missing.length) {
  console.error(`Not found on OpenRouter: ${missing.join(', ')}`);
  console.error('Refusing to write a partial catalogue — a missing model would price as free.');
  process.exit(1);
}

const catalog = {
  _note:
    'Pinned snapshot of OpenRouter list pricing. Regenerate with harness/pricing/fetch.mjs. ' +
    'These are what OpenRouter charges, which can differ from going direct to a provider.',
  source: 'https://openrouter.ai/api/v1/models',
  fetched_at: new Date().toISOString(),
  models: Object.fromEntries(
    MODELS.map((id) => {
      const m = data.find((x) => x.id === id);
      return [
        id,
        {
          name: m.name,
          context_length: m.context_length,
          pricing: m.pricing,
        },
      ];
    })
  ),
};

await mkdir(here, { recursive: true });
await writeFile(path.join(here, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Pinned ${MODELS.length} models → harness/pricing/catalog.json`);
console.log(`fetched_at: ${catalog.fetched_at}`);
