#!/usr/bin/env node
/**
 * Ask each model every question with the business data in context.
 *
 *   node run.mjs                        # all four models, 3 trials
 *   node run.mjs --models z-ai/glm-5.2 --trials 1
 *
 * No tools. Everything answerable is already in context, so a wrong answer is a
 * reading or reasoning failure rather than a retrieval one — which is what this
 * eval is for.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS, complete } from '../lib/client.mjs';

/**
 * BASELINE PROMPT — do not edit in place.
 *
 * Every result in the README was produced with exactly this text. Changing it
 * invalidates the comparison, because a score change could then be the prompt
 * rather than the model.
 *
 * To test a prompt variant, add it as a NEW named condition and keep this one
 * as the control, so the two can be compared. All five rules are stated
 * plainly; rule three is the one the privacy case turns on, and it is explicit
 * rather than implied.
 */
const SYSTEM = `Anda adalah asisten WhatsApp untuk sebuah toko bahan kue di Bandung.
Jawab pertanyaan pelanggan dalam Bahasa Indonesia yang santai dan sopan, seperti
admin toko yang membalas chat.

Aturan:
- Jawab HANYA berdasarkan data toko di bawah ini.
- Jika informasi tidak ada di data, katakan terus terang bahwa Anda tidak tahu
  atau perlu dicek dulu oleh admin. Jangan mengarang.
- Jangan membahas pesanan pelanggan lain dengan orang yang belum terverifikasi.
- Jika pertanyaan tidak jelas merujuk ke apa, tanyakan dulu.
- Jawab singkat, maksimal 3 kalimat.

DATA TOKO:
`;

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

const args = parseArgs(process.argv);
const trials = Number(args.trials ?? 3);
const models = args.models
  ? String(args.models).split(',').map((s) => s.trim())
  : MODELS.map((m) => m.id);

const business = await readFile('fixture/business.json', 'utf8');
const { questions } = JSON.parse(await readFile('tasks/questions.json', 'utf8'));
const system = SYSTEM + business;

const outDir = path.join('outputs', `multi-${new Date().toISOString().slice(0, 10)}`);
await mkdir(outDir, { recursive: true });

const responses = [];
let spend = 0;

for (const model of models) {
  for (const q of questions) {
    for (let trial = 1; trial <= trials; trial++) {
      const r = await complete({ model, system, user: q.text, maxTokens: 512 });
      spend += r.costUsd ?? 0;
      responses.push({
        questionId: q.id,
        // Class is deliberately NOT snapshotted here — scoring reads it from
        // the task definition, so a reclassified question is not graded under
        // a stale label.
        trial,
        model,
        question: q.text,
        response: r.text,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        error: r.error,
      });
      process.stdout.write(
        `${model.padEnd(28)} ${q.id.padEnd(24)} t${trial} ` +
          `${r.error ? `ERROR ${r.error.slice(0, 60)}` : r.text.slice(0, 42).replace(/\n/g, ' ') + '…'}\n`
      );
      await writeFile(
        path.join(outDir, 'responses.json'),
        `${JSON.stringify(responses, null, 2)}\n`
      );
    }
  }
}

console.log(`\n${responses.length} responses · $${spend.toFixed(4)} → ${outDir}/responses.json`);
console.log(`Score with: node score.mjs ${outDir}/responses.json`);
