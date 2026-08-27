/**
 * Minimal completion client, shared by the single-turn evals.
 *
 * Speaks the OpenAI chat-completions shape, which every backend in
 * `lib/backends.mjs` accepts — OpenRouter, OpenAI, an OpenAI-compatible
 * gateway, or anything self-hosted. Which one is used comes from
 * `EVAL_BACKEND`; the eval code never learns the difference.
 *
 * `swe-production` needs a full agent loop and uses Pi for it. These evals do
 * not: the model is given data and asked for one answer, so a plain completion
 * isolates the thing being measured. Adding an agent scaffold here would put a
 * second variable between the model and the score.
 */

import { resolveBackend, resolveModelId } from './backends.mjs';

export async function complete({
  model,
  system,
  user,
  maxTokens = 1024,
  temperature = null,
  apiKey,
  backend,
  timeoutMs = 180_000,
}) {
  // Resolving here rather than at import time means a missing key fails on the
  // first call with a message naming the variable, instead of at load.
  const target = backend ?? resolveBackend();
  const key = apiKey ?? target.apiKey;
  const started = Date.now();

  // A model with no id on this backend is a configuration error, but it comes
  // back as a failed row rather than a thrown exception: a sweep over six
  // models should report the one that is unmapped, not abort the other five.
  let upstreamModel;
  try {
    upstreamModel = resolveModelId(model, target.name);
  } catch (err) {
    return {
      text: '',
      error: String(err.message ?? err),
      costUsd: null,
      costSource: 'unavailable',
      backend: target.name,
      upstreamModel: null,
      latencyMs: Date.now() - started,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fail = (error) => ({
    text: '',
    error,
    costUsd: null,
    costSource: 'unavailable',
    backend: target.name,
    upstreamModel,
    latencyMs: Date.now() - started,
  });

  // Temperature is not sent by default. The current model generation has
  // retired the knob — the whole Claude 5 family and the GPT-5.6 line reject
  // any explicit value, while Claude 4.5, GPT-5.4 and the open-weight tier
  // still accept one. Sending nothing works everywhere; sending 0 fails on
  // exactly the models most worth testing, and a per-model allowlist would
  // need editing on every release.
  //
  // Determinism therefore comes from repeated trials, not from pinning. Pass
  // `temperature: 0` to reproduce numbers published before this changed; if a
  // model rejects it the call is retried without the field and the result
  // carries `temperaturePinned: false`, so a runner can report which rows were
  // not pinned rather than presenting the table as reproducible.
  const send = (withTemperature) =>
    fetch(target.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: upstreamModel,
        ...(withTemperature && temperature !== null && temperature !== undefined
          ? { temperature }
          : {}),
        max_tokens: maxTokens,
        // Only backends that understand cost accounting are asked for it;
        // others reject unknown top-level fields.
        ...target.extraBody,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
    });

  const rejectsTemperature = (t) =>
    /temperature/i.test(t) &&
    /(deprecated|unsupported|does not support|only the default|not supported)/i.test(t);

  try {
    let temperaturePinned = temperature !== null && temperature !== undefined;
    let res = await send(true);
    let bodyText = await res.text();

    if (!res.ok && temperaturePinned && rejectsTemperature(bodyText)) {
      res = await send(false);
      bodyText = await res.text();
      temperaturePinned = false;
    }

    if (!res.ok) return fail(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return fail(`unparseable response: ${bodyText.slice(0, 200)}`);
    }

    // An error can arrive inside a 200. Treating it as an empty answer would
    // score as a content failure rather than a transport one.
    if (body.error) {
      return fail(`${body.error.code ?? 'error'}: ${String(body.error.message).slice(0, 300)}`);
    }

    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? '';

    // Only OpenRouter reports what the call actually cost. Elsewhere this stays
    // null and says so, rather than reporting zero — a zero would read as a
    // free call and quietly corrupt any cost comparison.
    const costUsd = target.reportsCost ? (body.usage?.cost ?? null) : null;

    return {
      text: typeof text === 'string' ? text : JSON.stringify(text),
      error: text ? null : `empty completion (finish_reason=${choice?.finish_reason})`,
      costUsd,
      costSource: target.reportsCost ? 'provider' : 'unavailable',
      usage: body.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      backend: target.name,
      upstreamModel,
      temperaturePinned,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return fail(
      err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err.message ?? err)
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The models under test, one per price band. Mirrors swe-production/models.json. */
export const MODELS = [
  { id: 'anthropic/claude-sonnet-5', bracket: 'frontier' },
  { id: 'google/gemini-3.6-flash', bracket: 'frontier' },
  { id: 'openai/gpt-5.6-terra', bracket: 'frontier' },
  { id: 'z-ai/glm-5.2', bracket: 'economy' },
  { id: 'deepseek/deepseek-v4-flash', bracket: 'economy' },
  { id: 'openai/gpt-5.6-luna', bracket: 'economy' },
];

/**
 * Both gpt-5.6 models re-price above 272k prompt tokens — input and output
 * roughly double. None of the tests here run contexts that long, so the
 * headline rate is the one that applies. It would not be on a task that reads a
 * large codebase, which is worth remembering before reusing these figures.
 */

export { resolveBackend, resolveModelId } from './backends.mjs';
