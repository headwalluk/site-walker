/**
 * M23 per-chatbot rate-limiter. Fixed 60-second window, in-memory counters,
 * one bucket per `(chatbotId, scope)` pair.
 *
 * Per-IP rate limiting lives in `@fastify/rate-limit` on the route layer —
 * its `keyGenerator` is sync and `req.ip` is already available there. This
 * module handles the per-chatbot dimension, which has to run *after* the
 * route handler has resolved which chatbot the request is for (from Origin
 * for `POST /sessions`, from the session token for `POST /chat`). That
 * resolution is async, so a plugin-time keyGenerator can't cover it.
 *
 * **No persistence + no cross-instance coordination.** Each Node process
 * holds its own counters. Single-process deployment (v1.0.0) makes that
 * accurate; the cluster-mode pivot (post-v1.0.0, M11) is the milestone
 * that swaps both rate-limit stores for Redis.
 *
 * **No cleanup loop.** Stale buckets auto-overwrite on the next check.
 * At v1.0.0 scale (≤ a few hundred chatbots) the map size is bounded by
 * `2 × number of chatbots` and uses kilobytes.
 */

export type RateLimitScope = 'sessions' | 'chat';

export interface RateLimitCaps {
  /** Requests per minute against `POST /sessions` + `GET /sessions/can-start`. */
  readonly sessions: number;
  /** Requests per minute against `POST /chat`. */
  readonly chat: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds the caller should wait before retrying; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

export class ChatbotRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param caps    per-scope per-minute caps.
   * @param now     clock function. Injectable for tests; defaults to Date.now.
   */
  constructor(
    private readonly caps: RateLimitCaps,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Record an attempt against `(chatbotId, scope)` and decide whether to
   * allow it. Side-effectful: an allowed call bumps the bucket; a refused
   * call does not (so a single refused caller doesn't keep extending its
   * own ban window).
   */
  check(chatbotId: number, scope: RateLimitScope): RateLimitDecision {
    const key = `${chatbotId}:${scope}`;
    const cap = this.caps[scope];
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= cap) {
      const elapsed = now - bucket.windowStart;
      const remainingMs = Math.max(0, WINDOW_MS - elapsed);
      return {
        allowed: false,
        // Round UP to the next whole second so the caller waits long enough
        // for the window to reset; floor of 1s prevents a "retry immediately"
        // when we're at the very end of the window.
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Clear all buckets. Test-only helper; not exported in production paths. */
  reset(): void {
    this.buckets.clear();
  }
}
