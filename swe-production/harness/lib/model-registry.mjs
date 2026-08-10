/**
 * Resolve a model id to a descriptor Pi can drive.
 *
 * Pi ships a generated registry, but it lags — six of the eight models under
 * test are absent from it. Since `Model` is a plain interface, a descriptor can
 * be synthesised from the pinned OpenRouter catalogue instead, which is how
 * models stay configurable in `models.json` rather than gated on a dependency's
 * release cycle.
 *
 * The catch is that registry entries carry model-specific compatibility flags —
 * `requiresReasoningContentOnAssistantMessages`, thinking-level maps, reasoning
 * formats — that a synthesised descriptor cannot know. Reasoning models are
 * exactly where a missing flag bites, and it surfaces as garbled output or an
 * API error that reads like "this model is bad at coding".
 *
 * So: prefer the registry when it has the model, synthesise only when it does
 * not, and **record which path was taken on every run** so a compat failure is
 * attributable instead of mysterious.
 */

import { readFile } from 'node:fs/promises';

let piModels = null;

/**
 * Read Pi's registry through its public API.
 *
 * An earlier version imported `dist/models.generated.js` directly, which is not
 * an exported subpath. The import threw, a catch swallowed it, and every model
 * silently fell through to synthesis — including the two the registry actually
 * had. A degraded path that reports success is worse than a hard failure, so
 * this one throws.
 */
async function loadPiRegistry() {
  if (piModels) return piModels;
  const { getModels } = await import('@earendil-works/pi-ai');
  if (typeof getModels !== 'function') {
    throw new Error(
      'pi-ai does not export getModels(). The registry API changed; ' +
        'model resolution cannot silently fall back to synthesis.'
    );
  }
  piModels = new Map(getModels('openrouter').map((m) => [m.id, m]));
  return piModels;
}

let catalog = null;
async function loadCatalog() {
  if (catalog) return catalog;
  catalog = JSON.parse(
    await readFile(new URL('../pricing/catalog.json', import.meta.url), 'utf8')
  );
  return catalog;
}

/** OpenRouter prices per token; Pi's descriptors are per million. */
const perMillion = (v) => Number(v ?? 0) * 1e6;

export async function resolveModel(id) {
  const [registry, cat] = await Promise.all([loadPiRegistry(), loadCatalog()]);

  const fromRegistry = registry.get(id);
  if (fromRegistry) {
    return {
      model: { ...fromRegistry },
      source: 'pi-registry',
      compatKnown: true,
    };
  }

  const entry = cat.models?.[id];
  if (!entry) {
    throw new Error(
      `Model "${id}" is in neither Pi's registry nor the pinned catalogue.\n` +
        `Add it to harness/pricing/fetch.mjs and re-run that script.`
    );
  }

  const p = entry.pricing ?? {};
  return {
    model: {
      id,
      name: entry.name ?? id,
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true,
      input: ['text'],
      cost: {
        input: perMillion(p.prompt),
        output: perMillion(p.completion),
        cacheRead: perMillion(p.input_cache_read ?? p.prompt),
        cacheWrite: perMillion(p.input_cache_write ?? 0),
      },
      contextWindow: entry.context_length ?? 128000,
      // OpenRouter reserves credit for the full requested max_tokens before the
      // request runs, so an oversized value is rejected with a 402 on an account
      // that could easily afford the actual completion. The first version asked
      // for 64000 on every model; expensive models were refused outright while
      // cheap ones sailed through, which read as a capability difference and was
      // a billing check.
      //
      // 8192 is ample for a coding turn and cheap to reserve. Raise it only for
      // a task that genuinely needs longer output, and expect the reservation to
      // scale with the model's output price.
      maxTokens: 8192,
    },
    source: 'synthesised-from-catalog',
    // Loud on purpose. A synthesised descriptor has no compat flags, so the
    // first run of any such model is a smoke test, not a result.
    compatKnown: false,
    compatWarning:
      `No Pi registry entry for "${id}" — descriptor synthesised from OpenRouter ` +
      `pricing. Provider-specific compatibility flags (reasoning format, thinking ` +
      `levels) are unset. Treat the first run as a smoke test.`,
  };
}

/** Which models would be synthesised, so the risk is visible before spending. */
export async function auditModels(ids) {
  const rows = [];
  for (const id of ids) {
    try {
      const r = await resolveModel(id);
      rows.push({ id, source: r.source, compatKnown: r.compatKnown });
    } catch (err) {
      rows.push({ id, source: 'ERROR', error: String(err.message ?? err) });
    }
  }
  return rows;
}
