import { spawn } from 'node:child_process';

/**
 * Run a command and capture stdout/stderr. Never throws on a non-zero exit —
 * the exit code is part of what we measure, not an exception.
 */
export function run(cmd, args, { cwd, env, timeoutMs = 600_000, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
  });
}

/** Run and throw on failure. For setup steps where a failure invalidates the run. */
export async function runOrThrow(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.code}\n${r.stderr || r.stdout}`
    );
  }
  return r;
}

export const sh = (cmd, args, opts) => run(cmd, args, opts);

/** ISO timestamp safe for filenames. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
