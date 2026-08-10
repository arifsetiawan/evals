/**
 * Minimal OpenRouter completion client, shared by the single-turn evals.
 *
 * `swe-production` needs a full agent loop and uses Pi for it. These evals do
 * not: the model is given data and asked for one answer, so a plain completion
 * isolates the thing being measured. Adding an agent scaffold here would put a
 * second variable between the model and the score.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function complete({
  model,
  system,
  user,
  maxTokens = 1024,
  temperature = 0,
  apiKey = process.env.OPENROUTER_API_KEY,
  timeoutMs = 180_000,
}) {
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Put it in evals/.env — refusing to run ' +
        'rather than silently produce empty results.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        // Ask for usage accounting so cost is reported rather than modelled.
        usage: { include: true },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        text: '',
        error: `HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
        costUsd: null,
        latencyMs: Date.now() - started,
      };
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return {
        text: '',
        error: `unparseable response: ${bodyText.slice(0, 200)}`,
        costUsd: null,
        latencyMs: Date.now() - started,
      };
    }

    // An error can arrive inside a 200. Treating it as an empty answer would
    // score as a content failure rather than a transport one.
    if (body.error) {
      return {
        text: '',
        error: `${body.error.code ?? 'error'}: ${String(body.error.message).slice(0, 300)}`,
        costUsd: null,
        latencyMs: Date.now() - started,
      };
    }

    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? '';

    return {
      text: typeof text === 'string' ? text : JSON.stringify(text),
      error: text ? null : `empty completion (finish_reason=${choice?.finish_reason})`,
      costUsd: body.usage?.cost ?? null,
      usage: body.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      text: '',
      error: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err.message ?? err),
      costUsd: null,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The four models under test, one per price band. Mirrors swe-production/models.json. */
export const MODELS = [
  { id: 'anthropic/claude-sonnet-5', bracket: 'frontier' },
  { id: 'google/gemini-3.6-flash', bracket: 'frontier' },
  { id: 'z-ai/glm-5.2', bracket: 'economy' },
  { id: 'deepseek/deepseek-v4-flash', bracket: 'economy' },
];
