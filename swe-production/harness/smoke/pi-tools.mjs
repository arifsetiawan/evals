#!/usr/bin/env node
/**
 * Smoke-test the Pi coding tools without spending model tokens.
 *
 * The production harness depends on Pi's stock read/bash/edit/write tools.
 * A previous version passed `{ cwd }` to `createCodingTools` even though the
 * API expects `createCodingTools(cwd: string)`. Read and edit still worked, but
 * every bash call failed with "Working directory does not exist: [object
 * Object]", invalidating a full matrix. This test exercises the path that
 * failed: shell cwd, grep through bash, running tests, editing source, and
 * seeing tests pass.
 */

import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfinedCodingTools } from '../lib/pi-agent.mjs';

const textOf = (result) =>
  (result?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');

async function call(tool, args) {
  try {
    return await tool.execute(`smoke-${tool.name}`, args);
  } catch (err) {
    throw new Error(`${tool.name} failed: ${err.message ?? err}`);
  }
}

async function bash(tool, command, { allowFailure = false } = {}) {
  try {
    const result = await call(tool, { command, timeout: 20 });
    return textOf(result);
  } catch (err) {
    if (allowFailure) return String(err.message ?? err);
    throw err;
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function mustFail(fn, pattern, message) {
  try {
    await fn();
  } catch (err) {
    const text = String(err.message ?? err);
    if (pattern.test(text)) return;
    throw new Error(`${message}\nUnexpected error:\n${text}`);
  }
  throw new Error(`${message}\nExpected failure, got success.`);
}

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swe-pi-tools-')));

try {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'swe-pi-tools-smoke',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(root, 'src', 'pricing.mjs'),
    `export function total(base, discount) {
  // SYMBOL_DISCOUNT lives here so grep has to search the source tree.
  return base + discount - 1;
}
`
  );
  await writeFile(
    path.join(root, 'test', 'pricing.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { total } from '../src/pricing.mjs';

test('applies SYMBOL_DISCOUNT arithmetic', () => {
  assert.equal(total(40, 2), 42);
});
`
  );

  const confined = await createConfinedCodingTools(root);
  const tools = Object.fromEntries(confined.tools.map((tool) => [tool.name, tool]));
  for (const name of ['read', 'bash', 'edit', 'write']) {
    must(tools[name], `createCodingTools did not provide ${name}`);
  }

  const pwd = (await bash(tools.bash, 'pwd')).trim();
  must(pwd === root, `bash cwd mismatch: expected ${root}, got ${pwd || '<empty>'}`);

  const grep = await bash(tools.bash, 'grep -R "SYMBOL_DISCOUNT" src test');
  must(
    grep.includes('src/pricing.mjs') && grep.includes('test/pricing.test.mjs'),
    `grep did not see the expected source and test files:\n${grep}`
  );

  const before = await call(tools.read, { path: 'test/pricing.test.mjs' });
  must(
    textOf(before).includes('assert.equal(total(40, 2), 42)'),
    'read did not return the smoke test contents'
  );

  const failing = await bash(tools.bash, 'npm test', { allowFailure: true });
  must(/not ok|fail/i.test(failing), `npm test should fail before the edit:\n${failing}`);

  await call(tools.edit, {
    path: 'src/pricing.mjs',
    edits: [{ oldText: 'return base + discount - 1;', newText: 'return base + discount;' }],
  });

  const passing = await bash(tools.bash, 'npm test');
  must(/# pass 1|pass 1|ok 1/i.test(passing), `npm test should pass after the edit:\n${passing}`);

  await mustFail(
    () => call(tools.write, { path: path.join(tmpdir(), 'swe-pi-tools-escape.txt'), content: 'x' }),
    /outside the task sandbox/i,
    'sandbox guard should reject absolute writes outside the smoke root'
  );

  console.log('PASS pi tools smoke: bash cwd, grep, test failure, edit, test pass, sandbox guard');
} finally {
  await rm(root, { recursive: true, force: true });
}
