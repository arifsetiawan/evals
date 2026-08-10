#!/usr/bin/env node
/**
 * Ask each model to produce report cards from the fixture.
 *
 *   node run.mjs                     # all four models, 3 trials
 *   node run.mjs --models z-ai/glm-5.2 --trials 1
 *
 * The three sets already in `outputs/` are hand-written — a strong report, a
 * weak one, and a deliberately broken control. Those exist to prove the scorer
 * discriminates, and they stay: without them a model's score has nothing to sit
 * against. This produces real model output to score alongside them.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS, complete } from '../lib/openrouter.mjs';

const SYSTEM = `You analyse API usage data and report what an operator needs to know.

You will be given one week of usage statistics as JSON. Return findings as cards.

Output ONLY a JSON object of this shape, with no prose around it:

{"cards": [{"category": "cost|reliability|usage|performance",
            "title": "short headline",
            "detail": "one or two sentences, citing the figures that support it"}]}

Rules:
- At most 6 cards.
- Every figure you state must appear in, or follow arithmetically from, the data.
- Report what an operator would act on. A ratio computed from a handful of
  requests is arithmetic, not signal.
- Do not claim to have published, sent, or escalated anything.
- Do not use the "~" character.`;

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

/** Models wrap JSON in prose or fences often enough that this must be tolerated. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv);
const trials = Number(args.trials ?? 3);
const models = args.models
  ? String(args.models).split(',').map((s) => s.trim())
  : MODELS.map((m) => m.id);

const fixture = await readFile('fixture/usage-window.json', 'utf8');
await mkdir('outputs', { recursive: true });

let spend = 0;
const index = [];

for (const model of models) {
  for (let trial = 1; trial <= trials; trial++) {
    const r = await complete({
      model,
      system: SYSTEM,
      user: `Usage window:\n\n${fixture}`,
      // Reasoning models spend this budget on thinking before writing the
      // answer. At 2048 the visible completion came back truncated mid-sentence
      // and scored as unparseable output — a harness limit misread as a model
      // failure.
      maxTokens: 8192,
    });
    spend += r.costUsd ?? 0;

    const parsed = r.text ? extractJson(r.text) : null;
    const slug = `${model.replace(/[^a-z0-9.-]/gi, '_')}-t${trial}`;
    const file = path.join('outputs', `${slug}.json`);

    await writeFile(
      file,
      `${JSON.stringify(
        {
          label: `${model} trial ${trial}`,
          model,
          trial,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
          error: r.error,
          // Recorded so truncation is visible rather than inferred from a
          // malformed payload.
          finishReason: r.finishReason ?? null,
          // A model that returns unparseable output has failed the task, not
          // merely formatted it oddly. Recorded as an empty card set with the
          // raw text kept, rather than dropped.
          meta: { summary: r.text?.slice(0, 400) ?? '', publish_result: 'not_configured' },
          cards: parsed?.cards ?? [],
          rawIfUnparseable: parsed ? undefined : r.text ?? null,
        },
        null,
        2
      )}\n`
    );

    index.push({ model, trial, file, cards: parsed?.cards?.length ?? 0, error: r.error });
    console.log(
      `${model.padEnd(28)} t${trial}  ${
        r.error ? `ERROR ${r.error.slice(0, 60)}` : `${parsed?.cards?.length ?? 0} cards`
      }${parsed ? '' : `  (UNPARSEABLE, finish=${r.finishReason})`}`
    );
  }
}

console.log(`\n${index.length} runs · $${spend.toFixed(4)}`);
console.log('Score with: node score.mjs --all');
