/**
 * Drive a coding task with Pi, the neutral scaffold.
 *
 * Pi is the control for experiment A: it speaks OpenAI-completions to
 * OpenRouter, so every model under test runs through an identical agent loop
 * with identical tools. Comparing a vendor's own scaffold against a bare API
 * loop would measure the harness, not the model — this exists so the model is
 * the only variable.
 *
 * The Claude Code path (`agent.mjs`) is retained for experiment B, where the
 * model is held fixed and the scaffold varies.
 */

import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { resolveModel } from './model-registry.mjs';

const DEFAULT_MAX_TURNS = 60;

/**
 * Confine the agent to its worktree.
 *
 * Setting the session `cwd` does NOT bound writes — absolute paths reach
 * anywhere the process can. On 2026-08-07 a run given a vague task walked out
 * of its worktree and wrote 100 lines into a *sibling repository*, on `main`,
 * including a changelog edit that recategorised an existing entry. It was
 * plausible code for the task; it was also uncommitted changes in a live
 * product repo that nobody asked for.
 *
 * The lesson is the one the prompt cannot enforce: a rule the agent is *told*
 * is not a control. This wraps every tool that takes a path and rejects any
 * that resolves outside the sandbox.
 *
 * Violations are recorded rather than silently blocked — an agent reaching
 * outside its sandbox is reporting something about itself, and that belongs in
 * the results.
 */
function confineTools(tools, root) {
  const rootResolved = path.resolve(root);
  const inside = (p) => {
    const abs = path.resolve(rootResolved, p);
    return abs === rootResolved || abs.startsWith(rootResolved + path.sep);
  };

  const PATH_KEYS = ['path', 'file_path', 'filePath', 'dir', 'directory', 'cwd'];
  const escapes = [];

  const wrapped = tools.map((tool) => ({
    ...tool,
    execute: async (...callArgs) => {
      const args = typeof callArgs[0] === 'string' ? callArgs[1] : callArgs[0];
      for (const key of PATH_KEYS) {
        const v = args?.[key];
        if (typeof v === 'string' && v && !inside(v)) {
          escapes.push({ tool: tool.name, key, value: v });
          throw new Error(
            `Path outside the task sandbox: ${v}\n` +
              `This run is confined to ${rootResolved}. Work only within it.`
          );
        }
      }
      // Shell commands are not path-typed, so absolute writes are caught by
      // pattern rather than by resolution. Narrow on purpose: a redirect or an
      // edit aimed at an absolute path outside the sandbox.
      const cmd = args?.command;
      if (typeof cmd === 'string') {
        const abs = cmd.match(/(?:^|[\s>|])(\/[\w.\-/]+)/g) ?? [];
        for (const m of abs) {
          const p = m.trim().replace(/^[>|]\s*/, '');
          if (p.startsWith('/') && !inside(p) && !/^\/(usr|bin|tmp|opt|etc|dev|var)\b/.test(p)) {
            escapes.push({ tool: tool.name, key: 'command', value: p });
            throw new Error(
              `Command references a path outside the task sandbox: ${p}\n` +
                `This run is confined to ${rootResolved}.`
            );
          }
        }
      }
      return tool.execute(...callArgs);
    },
  }));

  return { tools: wrapped, escapes };
}

/** Usage across assistant messages, normalised to the field names the harness records. */
function collectUsage(messages) {
  const u = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  };
  let costUsd = 0;

  for (const m of messages) {
    const mu = m?.usage;
    if (!mu) continue;
    u.input_tokens += mu.input ?? mu.inputTokens ?? mu.input_tokens ?? 0;
    u.output_tokens += mu.output ?? mu.outputTokens ?? mu.output_tokens ?? 0;
    u.cache_read_input_tokens += mu.cacheRead ?? mu.cache_read ?? 0;
    u.cache_creation_input_tokens += mu.cacheWrite ?? mu.cache_write ?? 0;
    // Pi reports a cost when the descriptor carries pricing. Kept as reported;
    // the analysis re-prices from the pinned catalogue so every model is
    // compared on one price list.
    const c = mu.cost;
    if (typeof c === 'number') costUsd += c;
    else if (c && typeof c === 'object')
      costUsd += Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0);
  }
  // Pi does not distinguish cache TTLs; attribute to 5m so the pricing model
  // does not silently apply the more expensive 1h rate.
  u.cache_creation.ephemeral_5m_input_tokens = u.cache_creation_input_tokens;
  return { usage: u, costUsd: costUsd || null };
}

/** Tool calls, in order, for the process-correctness signals. */
function collectToolCalls(messages) {
  const calls = [];
  for (const m of messages) {
    for (const block of m?.content ?? []) {
      if (block?.type !== 'toolCall' && block?.type !== 'tool_use') continue;
      const args = block.arguments ?? block.input ?? {};
      calls.push({
        name: block.name ?? block.toolName ?? 'unknown',
        target:
          args.path ??
          args.file_path ??
          args.filePath ??
          args.pattern ??
          (typeof args.command === 'string' ? args.command.slice(0, 200) : null),
      });
    }
  }
  return calls;
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const text = (m.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

export async function createConfinedCodingTools(dest) {
  // Stock tools — read, bash, edit, write — so the scaffold is Pi's default
  // rather than something tuned per model. Wrapped only to confine paths to
  // the worktree; the tools' behavior is otherwise untouched.
  const { createCodingTools } = await import('@earendil-works/pi-coding-agent');
  // `createCodingTools(cwd: string)` — a string, not an options object.
  // Passing `{ cwd: dest }` stringified to "[object Object]", so every bash
  // call returned "Working directory does not exist" while read and edit kept
  // working. The agent looked functional and could not run a test, a grep, or
  // anything else. 27 runs were graded and published before this was found.
  return confineTools(createCodingTools(dest), dest);
}

export async function runPiAgent({
  dest,
  prompt,
  modelId,
  transcriptPath,
  maxTurns = DEFAULT_MAX_TURNS,
  apiKey = process.env.OPENROUTER_API_KEY,
}) {
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Put it in evals/.env — refusing to run ' +
        'rather than fall back to a different provider silently.'
    );
  }
  process.env.OPENROUTER_API_KEY = apiKey;

  const resolved = await resolveModel(modelId);
  const { createAgentSession } = await import('@earendil-works/pi-coding-agent');

  const transcript = createWriteStream(transcriptPath, { flags: 'w' });
  const events = [];
  const started = Date.now();

  let session;
  let aborted = false;
  let error = null;
  let escapeAttempts = [];

  try {
    const confined = await createConfinedCodingTools(dest);
    escapeAttempts = confined.escapes;

    const created = await createAgentSession({
      cwd: dest,
      model: resolved.model,
      // `tools` is an allowlist of NAMES, not tool objects — passing objects
      // there matched nothing and handed the agent an empty toolset, which
      // presented as every task failing instantly for a fifth of a cent.
      // Confined equivalents replace the built-ins outright.
      noTools: 'builtin',
      customTools: confined.tools,
    });
    session = created.session;

    // Pi emits `turn_start`/`turn_end`. An earlier version counted `message`
    // and `assistant`, which Pi never emits — the counter stayed at zero, the
    // cap never fired, and a looping agent ran unbounded until it was killed by
    // hand at 130 MB of transcript.
    let turns = 0;
    const unsubscribe = session.subscribe((event) => {
      const type = event?.type;

      // Streaming deltas are ~90% of the event volume and add nothing the
      // structural events do not already carry. Writing them produced 150 MB
      // transcripts per run. Kept in memory for tool extraction, off disk.
      if (type !== 'message_update' && type !== 'tool_execution_update') {
        transcript.write(`${JSON.stringify(event)}\n`);
      }
      if (type !== 'message_update') events.push(event);

      if (type === 'turn_start') turns++;
      if (turns > maxTurns && !aborted) {
        aborted = true;
        session.abort().catch(() => {});
      }
    });

    await session.prompt(prompt);
    unsubscribe();
  } catch (err) {
    error = String(err?.message ?? err);
  }

  const messages = session?.messages ?? [];

  // Pi reports a failed generation on the message, not by throwing: the message
  // comes back with `stopReason: "error"`, empty content, and zero tokens. Not
  // reading it meant a hard API failure was recorded as `completed` with no
  // output — 24 runs across two models were scored that way before this was
  // noticed, and they looked exactly like a model declining to act.
  const failedMessages = messages.filter((m) => m?.stopReason === 'error');
  const generationError = failedMessages.length
    ? failedMessages[failedMessages.length - 1].errorMessage ?? 'generation failed'
    : null;
  const { usage, costUsd } = collectUsage(messages);
  const toolCalls = collectToolCalls(messages);
  const resultText = lastAssistantText(messages);

  transcript.end();
  try {
    session?.dispose();
  } catch {
    /* disposal failures are not results */
  }

  return {
    scaffold: 'pi',
    model: modelId,
    modelSource: resolved.source,
    compatKnown: resolved.compatKnown,
    compatWarning: resolved.compatWarning ?? null,

    wallClockMs: Date.now() - started,
    costUsd,
    usage,
    numTurns: messages.filter((m) => m?.role === 'assistant').length,
    durationMs: Date.now() - started,
    terminalReason: aborted
      ? 'max_turns'
      : error || generationError
        ? 'error'
        : 'completed',
    apiErrorStatus: error ?? generationError,
    permissionDenials: [],
    isError: Boolean(error || generationError),
    resultText,

    toolCalls,
    eventCount: events.length,
    // Attempts to touch anything outside the worktree. Reported, not hidden:
    // an agent reaching out of its sandbox is a behavioural result.
    sandboxEscapeAttempts: escapeAttempts,
  };
}
