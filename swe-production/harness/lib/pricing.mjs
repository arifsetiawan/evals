/**
 * Cost model.
 *
 * List prices quoted as "$X in / $Y out" describe a workload this one is not.
 * Measured across real agentic coding runs, the token mix is **96% cache reads**,
 * 3% cache writes, and well under 1% output — the agent re-reads a large context
 * on every turn and writes very little. Cache reads price at roughly a tenth of
 * fresh input, so any in/out blend overstates cost, and does so unevenly across
 * providers depending on whether they price caching at all.
 *
 * So cost is modelled from the observed token mix against each model's full
 * pricing object, including cache rates and long-context override tiers.
 */

/** Prompt-side tokens, which is what override tiers are keyed on. */
function promptTokens(u) {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Some models re-price above a context threshold — `gpt-5.6-terra` doubles above
 * 272k prompt tokens. Agentic coding runs sit far above that, so applying the
 * headline rate would understate cost on every single run. Picks the
 * highest-threshold tier the run actually qualifies for.
 */
function effectiveRates(pricing, tokens) {
  let rates = pricing;
  for (const o of pricing.overrides ?? []) {
    if (tokens >= (o.min_prompt_tokens ?? Infinity)) {
      if (!rates.overrides || (o.min_prompt_tokens ?? 0) >= (rates._tier ?? 0)) {
        rates = { ...pricing, ...o, _tier: o.min_prompt_tokens };
      }
    }
  }
  return rates;
}

const num = (v) => Number(v ?? 0);

/**
 * Cost in USD for one run.
 *
 * `usage` uses Anthropic's field names, which is what the harness records.
 * Providers without a separate cache-write rate fall back to their prompt rate;
 * providers without a cache-read rate likewise, which correctly makes an
 * uncached provider look expensive on this workload rather than cheap.
 */
export function priceRun({ pricing, usage }) {
  if (!pricing || !usage) return null;

  const pTok = promptTokens(usage);
  const r = effectiveRates(pricing, pTok);

  const fresh = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;

  // Cache writes are billed by TTL, and the two rates differ by ~1.6x. Claude
  // Code writes 1-hour cache entries, so pricing them at the 5-minute rate
  // understated cost by a third of the cache-write line. The split is reported
  // in `usage.cache_creation`; fall back to the aggregate when absent.
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    usage.cache_creation?.ephemeral_5m_input_tokens ??
    (usage.cache_creation ? 0 : usage.cache_creation_input_tokens ?? 0);

  const rPrompt = num(r.prompt);
  const rRead = r.input_cache_read != null ? num(r.input_cache_read) : rPrompt;
  const rWrite5m = r.input_cache_write != null ? num(r.input_cache_write) : rPrompt;
  const rWrite1h =
    r.input_cache_write_1h != null ? num(r.input_cache_write_1h) : rWrite5m;
  const rOut = num(r.completion);

  const cacheWriteCost = write1h * rWrite1h + write5m * rWrite5m;

  return {
    usd: fresh * rPrompt + cacheRead * rRead + cacheWriteCost + out * rOut,
    tier: r._tier ?? null,
    breakdown: {
      fresh: fresh * rPrompt,
      cacheRead: cacheRead * rRead,
      cacheWrite: cacheWriteCost,
      output: out * rOut,
    },
    tokens: {
      fresh,
      cacheRead,
      cacheWrite1h: write1h,
      cacheWrite5m: write5m,
      out,
      promptTotal: pTok,
    },
  };
}

/**
 * What each model would have cost for the same work — a counterfactual, not a
 * measurement.
 *
 * This assumes every model consumes the same tokens as the run that was
 * actually observed, which is false in a specific and important way: a model
 * that needs more turns to reach the same answer consumes more tokens, and a
 * provider that does not cache the prompt shape pays fresh-input rates on
 * everything. Useful for bounding a decision before spending on a full matrix;
 * not a substitute for running it.
 */
export function counterfactual({ catalog, usage }) {
  return Object.entries(catalog.models)
    .map(([id, m]) => {
      const p = priceRun({ pricing: m.pricing, usage });
      return { id, usd: p?.usd ?? null, tier: p?.tier ?? null };
    })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

/** Aggregate observed token mix, so the shape of the workload is stated, not assumed. */
export function tokenMix(usages) {
  const s = { fresh: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
  for (const u of usages) {
    s.fresh += u.input_tokens ?? 0;
    s.cacheRead += u.cache_read_input_tokens ?? 0;
    s.cacheWrite += u.cache_creation_input_tokens ?? 0;
    s.out += u.output_tokens ?? 0;
  }
  const total = s.fresh + s.cacheRead + s.cacheWrite + s.out;
  return {
    ...s,
    total,
    pct: total
      ? {
          fresh: (100 * s.fresh) / total,
          cacheRead: (100 * s.cacheRead) / total,
          cacheWrite: (100 * s.cacheWrite) / total,
          out: (100 * s.out) / total,
        }
      : null,
  };
}
