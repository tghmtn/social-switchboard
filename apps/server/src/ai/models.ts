// The AI providers a workspace can use (bring your own key), and what we know about prices.
// Model lists come live from each provider (see providers.ts), so new models show up without an
// update here; this file only holds list prices for the usage estimate, which a model missing
// from it simply goes without.

export const PROVIDERS = ['anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
};

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'medium';

/** Used until someone picks a Claude model. OpenAI's default is picked from its live list. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

type Price = { label: string; input: number; output: number; cacheRead: number };

/** US dollars per million tokens, Anthropic API list prices as of 2026-10. */
const KNOWN_PRICES: Record<string, Price> = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export const priceOf = (model: string): Price | undefined => KNOWN_PRICES[model];

/**
 * Estimated dollars for some usage, or null when we don't know the model's prices.
 * Cache writes cost 1.25x input (Anthropic's five-minute cache; OpenAI reports none).
 */
export function estimateCost(
  model: string,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const p = priceOf(model);
  if (!p) return null;
  return (
    (u.input * p.input +
      u.cacheWrite * p.input * 1.25 +
      u.cacheRead * p.cacheRead +
      u.output * p.output) /
    1_000_000
  );
}
