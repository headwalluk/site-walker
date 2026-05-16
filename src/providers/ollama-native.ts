import type { ChatRequest, ChatResponse, NormalisedParameters, ProtocolAdapter } from './types.js';

interface OllamaChatOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
}

function translateParameters(p: NormalisedParameters): OllamaChatOptions {
  const out: OllamaChatOptions = {};
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.top_p !== undefined) out.top_p = p.top_p;
  if (p.max_tokens !== undefined) out.num_predict = p.max_tokens;
  if (p.stop !== undefined) out.stop = p.stop;
  return out;
}

export class OllamaNativeAdapter implements ProtocolAdapter {
  readonly protocol = 'ollama-native';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error('ollama-native adapter requires base_url');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/api/chat`;
    const options = translateParameters(req.parameters);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
    };
    if (Object.keys(options).length > 0) {
      body.options = options;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ollama-native: POST ${url} failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (!data.message || typeof data.message.content !== 'string') {
      throw new Error(`ollama-native: response from ${url} had no message.content`);
    }

    const result: ChatResponse = { reply: data.message.content };
    if (typeof data.prompt_eval_count === 'number' && typeof data.eval_count === 'number') {
      result.tokensUsed = {
        prompt: data.prompt_eval_count,
        completion: data.eval_count,
      };
    }
    return result;
  }
}
