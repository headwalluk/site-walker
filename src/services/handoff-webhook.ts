import type { Knex } from 'knex';
import type { Chatbot } from './chatbots.js';
import type { Session } from './sessions.js';

/**
 * Fire-and-forget webhook notification when a session ends with a captured
 * visitor email. Best-effort delivery — failures log and continue; never
 * break the chat flow. No retry, no signing in v1 (operator responsible
 * for receiver idempotency).
 *
 * On successful delivery, stamps `sessions.handoff_notified_at`. Repeated
 * calls for the same session are safe: the receiver may see duplicates if
 * the timestamp persistence raced; idempotency lives on the operator's
 * side.
 *
 * Per dev-notes/11-budget-handoff.md and the M20 design pass on 2026-05-21.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface HandoffWebhookPayload {
  event: 'session_handoff';
  chatbot_slug: string;
  session_id: number;
  visitor_email: string | null;
  terminated_at: string;
  spend_usd: number;
}

export interface NotifyHandoffInput {
  db: Knex;
  chatbot: Chatbot;
  session: Session;
  /** Total USD spend on the session at termination time. */
  spendUsd: number;
}

/**
 * POST the payload to the chatbot's `handoff_webhook_url`. Returns true on
 * 2xx, false on any error (logged). When the chatbot has no webhook URL
 * configured, returns false without attempting any HTTP work.
 */
export async function notifyHandoff(input: NotifyHandoffInput): Promise<boolean> {
  const { db, chatbot, session, spendUsd } = input;
  if (!chatbot.handoff_webhook_url) return false;

  const payload: HandoffWebhookPayload = {
    event: 'session_handoff',
    chatbot_slug: chatbot.slug,
    session_id: session.id,
    visitor_email: session.visitor_email,
    terminated_at:
      session.terminated_at instanceof Date
        ? session.terminated_at.toISOString()
        : new Date().toISOString(),
    spend_usd: spendUsd,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(chatbot.handoff_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `handoff webhook: POST ${chatbot.handoff_webhook_url} → ${res.status} ${res.statusText}`,
      );
      return false;
    }
    await db('sessions').where({ id: session.id }).update({ handoff_notified_at: db.fn.now() });
    return true;
  } catch (err) {
    console.error(
      `handoff webhook: POST ${chatbot.handoff_webhook_url} failed: ${(err as Error).message}`,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
