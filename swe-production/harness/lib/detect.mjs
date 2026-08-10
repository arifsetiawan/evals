/**
 * Work out how a repository is laid out, instead of assuming.
 *
 * The first version of this harness hardcoded one repository's workspace names
 * and one test-runner config path. It ran fine against that repository and
 * would have linked no dependencies and found no config against any other,
 * while the README claimed it was repo-agnostic. Detection replaces the
 * assumption; anything undetectable is a flag, and an unsupported repo fails
 * loudly rather than producing empty results.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Directories that need `node_modules` linked into the worktree.
 *
 * Read from the package manager's own workspace declaration where there is one,
 * so a monorepo works without being described by hand.
 */
export async function detectLinkDirs(repo) {
  const dirs = new Set(['']);

  const pkg = await readJson(path.join(repo, 'package.json'));
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;

  if (Array.isArray(ws)) {
    for (const pattern of ws) {
      if (!pattern.includes('*')) {
        dirs.add(pattern.replace(/\/$/, ''));
        continue;
      }
      // Expand a single trailing glob: "packages/*" → each child with a package.json
      const base = pattern.replace(/\/\*+$/, '');
      const abs = path.join(repo, base);
      if (!existsSync(abs)) continue;
      for (const e of await readdir(abs, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(path.join(abs, e.name, 'package.json'))) {
          dirs.add(`${base}/${e.name}`);
        }
      }
    }
  }

  // pnpm keeps workspaces in their own file rather than package.json.
  const pnpm = path.join(repo, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    const text = await readFile(pnpm, 'utf8');
    for (const m of text.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?/gm)) {
      const p = m[1].trim().replace(/\/\*+$/, '');
      if (p && !p.startsWith('!')) dirs.add(p);
    }
  }

  return [...dirs];
}

const RUNNERS = [
  { name: 'vitest', configs: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'] },
  { name: 'jest', configs: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.json'] },
];

/**
 * Which test runner a workspace uses, and where its config lives.
 *
 * `workspace` may be '' for a single-package repository, which is the layout
 * the hardcoded version could not express at all.
 */
export async function detectRunner({ repo, workspace }) {
  const dir = path.join(repo, workspace);

  for (const runner of RUNNERS) {
    for (const cfg of runner.configs) {
      if (existsSync(path.join(dir, cfg))) {
        return { runner: runner.name, config: cfg, root: workspace, configDir: workspace };
      }
      // A monorepo often keeps one config at the root for every workspace.
      if (workspace && existsSync(path.join(repo, cfg))) {
        return { runner: runner.name, config: cfg, root: workspace, configDir: '' };
      }
    }
  }

  // No config file: fall back to whichever runner is actually a dependency.
  const pkg =
    (await readJson(path.join(dir, 'package.json'))) ??
    (await readJson(path.join(repo, 'package.json')));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  for (const runner of RUNNERS) {
    if (deps?.[runner.name]) {
      return { runner: runner.name, config: null, root: workspace, configDir: null };
    }
  }
  if (pkg?.scripts?.test?.includes('node --test')) {
    return { runner: 'node', config: null, root: workspace, configDir: null };
  }

  return null;
}

/** Everything the harness needs to know about a repository, in one call. */
export async function describeRepo({ repo, workspaces = [] }) {
  const linkDirs = await detectLinkDirs(repo);
  const runners = {};
  for (const w of workspaces.length ? workspaces : ['']) {
    runners[w] = await detectRunner({ repo, workspace: w });
  }
  return { repo, linkDirs, runners };
}
