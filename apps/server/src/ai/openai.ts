// A small client for the OpenAI API (the Responses and Models endpoints), over fetch.

export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let doFetch: typeof fetch = (...args) => fetch(...args);
/** Swappable for tests. */
export function setOpenAiFetch(f: typeof fetch) {
  doFetch = f;
}

export async function openai<T>(
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
  timeoutMs = 60_000,
): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(`https://api.openai.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new OpenAiError(0, err instanceof Error ? err.message : String(err));
  }
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: string } })
    | null;
  if (!res.ok)
    throw new OpenAiError(
      res.status,
      json?.error?.message ?? `OpenAI answered ${res.status}`,
      json?.error?.code,
    );
  return json as T;
}

/** The parts of a Responses API result we use. */
export type OpenAiResponse = {
  model: string;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress' | string;
  incomplete_details?: { reason?: string } | null;
  output: OpenAiItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

export type OpenAiItem =
  | {
      type: 'message';
      role: string;
      content: { type: 'output_text' | 'refusal' | string; text?: string; refusal?: string }[];
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'reasoning' | string; [key: string]: unknown };

/** The visible text of a response, and whether it refused. */
export function outputText(r: OpenAiResponse) {
  let text = '';
  let refused = false;
  for (const item of r.output)
    if (item.type === 'message')
      for (const c of (item as Extract<OpenAiItem, { type: 'message' }>).content) {
        if (c.type === 'output_text') text += c.text ?? '';
        if (c.type === 'refusal') refused = true;
      }
  return { text, refused };
}
