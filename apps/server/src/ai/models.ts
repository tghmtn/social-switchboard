// The Claude models the workspace can pick for its AI features, with list prices for the usage
// estimate (US dollars per million tokens, Anthropic API rates as of 2026-10). Bring your own key:
// usage is billed by Anthropic to that key; these numbers only estimate it.

export type AiModel = {
  id: string;
  label: string;
  note: string;
  input: number;
  output: number;
  cacheRead: number;
  /** Refused requests can be retried on another model by the API itself (not on Haiku). */
  fallbacks: boolean;
};

export const AI_MODELS: AiModel[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    note: 'The most capable. Best for building flows.',
    input: 4,
    output: 20,
    cacheRead: 0.2,
    fallbacks: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    note: 'Fast and capable, half the price.',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    fallbacks: true,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    note: 'Quickest and cheapest; fine for questions, weaker at building.',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    fallbacks: false,
  },
];

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'medium';

export const modelFor = (id: string | null | undefined) =>
  AI_MODELS.find((m) => m.id === id) ?? (AI_MODELS[0] as AiModel);

/** Estimated dollars for some usage. Cache writes cost 1.25x input (five-minute cache). */
export function estimateCost(
  modelId: string,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const m = modelFor(modelId);
  return (
    (u.input * m.input +
      u.cacheWrite * m.input * 1.25 +
      u.cacheRead * m.cacheRead +
      u.output * m.output) /
    1_000_000
  );
}
