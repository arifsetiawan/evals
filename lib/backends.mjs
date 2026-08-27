/**
 * Backends an eval can run against.
 *
 * Every backend here speaks the OpenAI chat-completions shape, so one client
 * (`lib/client.mjs`) covers all of them and the eval code never learns which
 * one is in use. Selection is by the `EVAL_BACKEND` environment variable.
 *
 * OpenRouter is the default and must stay the default: every number published
 * in a README was produced through it, and silently changing the route would
 * make a score difference unattributable to either the model or the prompt.
 *
 * Adding a backend is an entry here, not a code change.
 *
 * No endpoint belonging to a private deployment goes in this file. Anything
 * self-hosted or customer-specific supplies its URL through `baseUrlEnv`, so
 * the repository never carries someone's internal address.
 */

export const BACKENDS = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    // OpenRouter bills the caller and reports what the call cost, so cost is
    // measured rather than modelled. No other backend here does this.
    reportsCost: true,
    // Asks for that accounting. Other backends reject unknown top-level fields,
    // so it is sent only where it is understood.
    extraBody: { usage: { include: true } },
  },

  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    reportsCost: false,
  },

  tare: {
    label: 'Tetrate Agent Router Enterprise',
    // Deployment-specific. Set TARE_BASE_URL to the gateway base, e.g.
    // https://<your-gateway-host> — the client appends /v1/chat/completions.
    baseUrlEnv: 'TARE_BASE_URL',
    keyEnv: 'TARE_API_KEY',
    reportsCost: false,
  },

  compatible: {
    label: 'OpenAI-compatible endpoint',
    // Anything that speaks /v1/chat/completions: vLLM, Ollama, LiteLLM, a
    // self-hosted gateway. Both values come from the environment.
    baseUrlEnv: 'EVAL_BASE_URL',
    keyEnv: 'EVAL_API_KEY',
    reportsCost: false,
  },
};

export const DEFAULT_BACKEND = 'openrouter';

/**
 * Resolve the active backend from the environment, with its base URL and key
 * filled in. Throws rather than falling back, because a run that silently used
 * a different route than intended would produce numbers nobody could trust.
 */
export function resolveBackend(env = process.env) {
  const name = env.EVAL_BACKEND || DEFAULT_BACKEND;
  const spec = BACKENDS[name];
  if (!spec) {
    throw new Error(
      `Unknown EVAL_BACKEND "${name}". Available: ${Object.keys(BACKENDS).join(', ')}`
    );
  }

  const baseUrl = spec.baseUrl ?? env[spec.baseUrlEnv];
  if (!baseUrl) {
    throw new Error(
      `${spec.baseUrlEnv} is not set, and backend "${name}" has no default base URL. ` +
        `Put it in evals/.env.`
    );
  }

  const apiKey = env[spec.keyEnv];
  if (!apiKey) {
    throw new Error(
      `${spec.keyEnv} is not set. Put it in evals/.env — refusing to run rather ` +
        `than silently produce empty results.`
    );
  }

  return {
    name,
    label: spec.label,
    endpoint: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    apiKey,
    reportsCost: Boolean(spec.reportsCost),
    extraBody: spec.extraBody ?? {},
  };
}

/**
 * Model ids differ per backend: OpenRouter namespaces by vendor
 * (`z-ai/glm-5.2`), a gateway may namespace by upstream provider
 * (`deepinfra/zai-org/GLM-5.2`), and a first-party API uses a bare name.
 *
 * OpenRouter ids are canonical here because the published results used them.
 * A backend missing an entry is an error at resolution time, not a silent
 * fallback to a name that backend would reject in a way that scores as a
 * model failure.
 */
export const MODEL_IDS = {
  'anthropic/claude-sonnet-5': { openai: null, tare: 'claude-sonnet-5' },
  'google/gemini-3.6-flash': { openai: null, tare: null },
  'openai/gpt-5.6-terra': { openai: 'gpt-5.6-terra', tare: 'gpt-5.6-terra' },
  'openai/gpt-5.6-luna': { openai: 'gpt-5.6-luna', tare: 'gpt-5.6-luna' },
  'z-ai/glm-5.2': { openai: null, tare: 'deepinfra/zai-org/GLM-5.2' },
  'deepseek/deepseek-v4-flash': { openai: null, tare: 'deepinfra/deepseek-ai/DeepSeek-V4-Flash' },
};

/**
 * Translate a canonical model id for the active backend. Unknown models pass
 * through unchanged so a backend can be pointed at a model this file has never
 * heard of without editing it.
 */
export function resolveModelId(canonicalId, backendName) {
  if (backendName === 'openrouter' || backendName === 'compatible') return canonicalId;
  const entry = MODEL_IDS[canonicalId];
  if (!entry) return canonicalId;
  const mapped = entry[backendName];
  if (mapped === null) {
    throw new Error(
      `Model "${canonicalId}" has no known id on backend "${backendName}". ` +
        `Add one to MODEL_IDS in lib/backends.mjs, or exclude it with --models.`
    );
  }
  return mapped ?? canonicalId;
}
