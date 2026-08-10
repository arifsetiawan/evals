import { createWriteStream } from 'node:fs';
import { run } from './util.mjs';

/**
 * Drive Claude Code headlessly against a prepared worktree.
 *
 * `--output-format stream-json --verbose` emits one JSON object per line and a
 * final `result` object carrying cost, token usage, turn count, duration and
 * any permission denials. Everything the analysis needs is already in that
 * stream, so the harness adds no instrumentation of its own — it records what
 * the CLI reports.
 */
export async function runAgent({
  dest,
  prompt,
  model,
  transcriptPath,
  timeoutMs = 1_800_000,
  maxBudgetUsd = 5,
  settingSources = 'project',
}) {
  const transcript = createWriteStream(transcriptPath, { flags: 'w' });
  const events = [];
  let buffer = '';

  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(maxBudgetUsd),
    // Load the repo's own CLAUDE.md (it is part of the task context a real
    // developer would have) but not the operator's personal settings, which
    // would make results depend on whose laptop ran them.
    '--setting-sources',
    settingSources,
    '--no-session-persistence',
  ];

  const started = Date.now();

  const r = await run('claude', args, {
    cwd: dest,
    timeoutMs,
    onStdout: (chunk) => {
      transcript.write(chunk);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // Non-JSON noise on stdout; the raw transcript keeps it either way.
        }
      }
    },
  });

  transcript.end();

  const result = events.find((e) => e.type === 'result') ?? null;
  const toolCalls = collectToolCalls(events);

  return {
    wallClockMs: Date.now() - started,
    exitCode: r.code,
    timedOut: r.timedOut,
    stderr: r.stderr.slice(-4000),

    // Straight from the CLI's own accounting.
    costUsd: result?.total_cost_usd ?? null,
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    durationApiMs: result?.duration_api_ms ?? null,
    apiErrorStatus: result?.api_error_status ?? null,
    terminalReason: result?.terminal_reason ?? null,
    permissionDenials: result?.permission_denials ?? [],
    isError: result?.is_error ?? null,
    resultText: result?.result ?? null,

    toolCalls,
    eventCount: events.length,
  };
}

/**
 * Tool-call sequence, which is where the interesting failure modes live: which
 * files it opened before editing, whether it ran the tests itself, how many
 * times it retried the same edit.
 */
function collectToolCalls(events) {
  const calls = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const block of e.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      calls.push({
        name: block.name,
        // Keep the shape, drop the payload: file contents would balloon the
        // record and are recoverable from the raw transcript.
        target:
          block.input?.file_path ??
          block.input?.path ??
          block.input?.pattern ??
          (typeof block.input?.command === 'string'
            ? block.input.command.slice(0, 200)
            : null),
      });
    }
  }
  return calls;
}
