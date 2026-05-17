import type { ChatRequest, ChatResponse, NormalisedParameters, ProtocolAdapter } from './types.js';

/**
 * Default base URL when the operator's site-walker.toml entry doesn't set one.
 * Override is supported (e.g. a self-hosted OpenAI-compatible proxy that
 * speaks OpenRouter's wire shape).
 */
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter recommends sending HTTP-Referer + X-Title so requests show up
 * attributed in their dashboards. Defaulting these here keeps every site-walker
 * deployment identifiable as "Site Walker" without per-operator config.
 */
const DEFAULT_REFERER = 'https://site-walker.net';
const DEFAULT_TITLE = 'Site Walker';

interface OpenAIChatBody {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  stream: false;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { role?: string; content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function buildBody(req: ChatRequest): OpenAIChatBody {
  const body: OpenAIChatBody = {
    model: req.model,
    messages: req.messages,
    stream: false,
  };
  const p: NormalisedParameters = req.parameters;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.top_p !== undefined) body.top_p = p.top_p;
  if (p.max_tokens !== undefined) body.max_tokens = p.max_tokens;
  if (p.stop !== undefined) body.stop = p.stop;
  return body;
}

export interface OpenRouterAdapterOpts {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
}

export class OpenRouterAdapter implements ProtocolAdapter {
  readonly protocol = 'openrouter';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly referer: string;
  private readonly title: string;

  constructor(opts: OpenRouterAdapterOpts) {
    if (!opts.apiKey) {
      throw new Error('openrouter adapter requires api_key');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '');
    this.referer = opts.referer ?? DEFAULT_REFERER;
    this.title = opts.title ?? DEFAULT_TITLE;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': this.referer,
        'X-Title': this.title,
      },
      body: JSON.stringify(buildBody(req)),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `openrouter: POST ${url} failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`openrouter: response from ${url} had no choices[0].message.content`);
    }

    const result: ChatResponse = { reply: content };
    if (
      typeof data.usage?.prompt_tokens === 'number' &&
      typeof data.usage?.completion_tokens === 'number'
    ) {
      result.tokensUsed = {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
      };
    }
    return result;
  }
}
