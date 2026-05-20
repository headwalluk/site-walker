import { z } from 'zod';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  parameters: NormalisedParameters;
}

export interface ChatResponse {
  reply: string;
  tokensUsed?: { prompt: number; completion: number };
}

export interface ProtocolAdapter {
  readonly protocol: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/**
 * Canonical per-chatbot parameter schema (v1).
 * Unknown keys are rejected (strict). New keys are added here only when a
 * concrete need arises; see dev-notes/03-llm-providers.md.
 */
export const NormalisedParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).optional(),
    stop: z.array(z.string()).optional(),
  })
  .strict();

export type NormalisedParameters = z.infer<typeof NormalisedParametersSchema>;

/**
 * Split a model slug on the first `/`. Everything before is the provider
 * name (looked up in the TOML registry); everything after is the model
 * string (passed verbatim to the adapter).
 *
 *   'pi/qwen2:1.5b'                     → { provider: 'pi', model: 'qwen2:1.5b' }
 *   'openrouter/anthropic/claude-x'     → { provider: 'openrouter', model: 'anthropic/claude-x' }
 *   'anthropic/claude-haiku-4.5'        → { provider: 'anthropic', model: 'claude-haiku-4.5' }
 */
export function parseModelSlug(slug: string): { provider: string; model: string } {
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) {
    throw new Error(
      `Invalid model slug "${slug}": expected "<provider>/<model>" with non-empty parts.`,
    );
  }
  return { provider: slug.slice(0, idx), model: slug.slice(idx + 1) };
}
