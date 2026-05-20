import type { Knex } from 'knex';

/**
 * Per-message USD cost estimate for M18.
 *
 * Four input buckets:
 * 1. `tokensIn` — uncached input tokens, billed at the provider's input price.
 * 2. `cacheCreationTokens` — tokens just written to the provider's prompt
 *    cache. Anthropic bills these at 1.25× input price (a one-time premium
 *    versus the long-term saving of cache hits).
 * 3. `cacheReadTokens` — tokens read from the provider's prompt cache.
 *    Anthropic bills these at 0.10× input price.
 * 4. `tokensOut` — completion tokens. Always billed at the provider's output
 *    price; never cacheable.
 *
 * The cache buckets stay NULL/0 until the post-M20 milestone wires the
 * OpenRouter adapter to send Anthropic `cache_control` markers. Today every
 * row has cache fields = NULL and the formula degenerates to the simple
 * `(tokensIn × input + tokensOut × output) / 1M` shape.
 *
 * The multipliers below are hardcoded Anthropic constants — they match
 * Anthropic's published prompt-caching pricing. If/when OpenAI, Google, or
 * other providers ship caching with different multipliers, the right move
 * is to push these onto the `providers` (or `provider_models`) row so each
 * provider carries its own — and feed them in here as part of the input
 * shape. See feedback-configurable-over-magic-numbers memory for the
 * rationale.
 */

/** Anthropic cache-write premium: 1.25× input price. */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

/** Anthropic cache-read discount: 0.10× input price. */
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;

export interface ComputeCostInput {
  /** Uncached input tokens. NULL = adapter didn't report (treated as 0). */
  tokensIn: number | null | undefined;
  /** Completion tokens. NULL = adapter didn't report (treated as 0). */
  tokensOut: number | null | undefined;
  /** Tokens just written to the prompt cache. NULL = caching not wired/active. */
  cacheCreationTokens?: number | null;
  /** Tokens read from the prompt cache. NULL = caching not wired/active. */
  cacheReadTokens?: number | null;
  /** USD per million input tokens. NULL = provider is unmetered (cost = 0). */
  inputPerMillionUsd: number | null;
  /** USD per million output tokens. NULL = provider is unmetered (cost = 0). */
  outputPerMillionUsd: number | null;
}

/**
 * Compute the USD cost estimate for a single assistant turn. Pure function;
 * no DB, no I/O. Returns a number rounded to 6 decimal places (matching the
 * `messages.cost_usd_estimate DECIMAL(10,6)` column precision).
 *
 * Returns 0 when either pricing column is NULL — the provider is unmetered
 * (Ollama), or the operator hasn't yet set pricing on the model row.
 */
export function computeCostUsd(input: ComputeCostInput): number {
  const { inputPerMillionUsd, outputPerMillionUsd } = input;
  if (inputPerMillionUsd === null || outputPerMillionUsd === null) {
    return 0;
  }

  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;
  const cacheWrite = input.cacheCreationTokens ?? 0;
  const cacheRead = input.cacheReadTokens ?? 0;

  const inputBucket =
    tokensIn * inputPerMillionUsd +
    cacheWrite * ANTHROPIC_CACHE_WRITE_MULTIPLIER * inputPerMillionUsd +
    cacheRead * ANTHROPIC_CACHE_READ_MULTIPLIER * inputPerMillionUsd;
  const outputBucket = tokensOut * outputPerMillionUsd;

  const totalCents = inputBucket + outputBucket;
  const usd = totalCents / 1_000_000;

  // Round to 6dp to align with the DECIMAL(10,6) column.
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export interface ChatbotUsage {
  messageCount: number;
  /** Sum of `tokens_in` over the window; 0 when nothing recorded yet. */
  tokensIn: number;
  /** Sum of `tokens_out` over the window. */
  tokensOut: number;
  /** Sum of `cost_usd_estimate` over the window, as a number. */
  costUsd: number;
  /** Sum of `cache_creation_input_tokens` (post-M20 milestone surface). */
  cacheCreationTokens: number;
  /** Sum of `cache_read_input_tokens` (post-M20 milestone surface). */
  cacheReadTokens: number;
}

/**
 * Aggregate usage stats for a chatbot. Returns zeroes when no rows match.
 * `since`, when supplied, narrows to `messages.created_at >= since`. Uses
 * the M18 composite index `(chatbot_id, created_at)`.
 */
export async function getChatbotUsage(
  db: Knex,
  chatbotId: number,
  since?: Date,
): Promise<ChatbotUsage> {
  const query = db('messages')
    .where({ chatbot_id: chatbotId })
    .count<{ message_count: string | number }[]>({ message_count: '*' })
    .sum<{ total_tokens_in: string | number | null }[]>({ total_tokens_in: 'tokens_in' })
    .sum<{ total_tokens_out: string | number | null }[]>({ total_tokens_out: 'tokens_out' })
    .sum<{ total_cost: string | number | null }[]>({ total_cost: 'cost_usd_estimate' })
    .sum<
      {
        total_cache_writes: string | number | null;
      }[]
    >({ total_cache_writes: 'cache_creation_input_tokens' })
    .sum<
      {
        total_cache_reads: string | number | null;
      }[]
    >({ total_cache_reads: 'cache_read_input_tokens' });

  if (since) {
    query.andWhere('created_at', '>=', since);
  }

  const row = (await query.first()) as
    | {
        message_count: string | number;
        total_tokens_in: string | number | null;
        total_tokens_out: string | number | null;
        total_cost: string | number | null;
        total_cache_writes: string | number | null;
        total_cache_reads: string | number | null;
      }
    | undefined;

  return {
    messageCount: Number(row?.message_count ?? 0),
    tokensIn: Number(row?.total_tokens_in ?? 0),
    tokensOut: Number(row?.total_tokens_out ?? 0),
    costUsd: Number(row?.total_cost ?? 0),
    cacheCreationTokens: Number(row?.total_cache_writes ?? 0),
    cacheReadTokens: Number(row?.total_cache_reads ?? 0),
  };
}

/**
 * Parse a relative duration like `24h`, `7d`, `30d`, `5m`, `90s` into a
 * `Date` representing "now minus that duration". Throws on malformed input.
 * Single-unit form only — no compound `1h30m`. Operators with finer needs
 * can settle for a slightly bigger window (we're aggregating, not slicing).
 */
export function parseSinceDuration(raw: string, now: Date = new Date()): Date {
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) {
    throw new Error(`--since must be a relative duration like 30m, 24h, 7d (got "${raw}").`);
  }
  const n = Number(match[1]);
  if (n <= 0) {
    throw new Error(`--since duration must be positive (got "${raw}").`);
  }
  const unit = match[2];
  const ms =
    unit === 's'
      ? n * 1000
      : unit === 'm'
        ? n * 60_000
        : unit === 'h'
          ? n * 3_600_000
          : n * 86_400_000;
  return new Date(now.getTime() - ms);
}
