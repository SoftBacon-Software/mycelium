// =============== MYCELIUM — DB entity: webhooks + delivery log ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Carries the `crypto`
// (HMAC) and `assertPublicHost`/`guardedFetch`/`SSRFBlockedError`
// (../lib/ssrf-guard.js) imports out of the db.js header — they're used only
// inside this module. NOTE: master's `dispatchWebhook` uses `guardedFetch`
// (re-runs the SSRF guard on every redirect hop) with a `deliverWithRetry`
// closure; the readme-positioning blueprint showed an older `assertPublicHost`-
// only version — this is the real, redirect-safe code, moved verbatim.
// `dispatchWebhook` is imported by 6 route modules — high fan-in, zero fan-out.
// The functions below use only the live `db` binding from ./core.js. Bodies
// moved VERBATIM — bare db.prepare(...) keeps working via the ESM live binding
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/webhooks.js'` so no consumer changes
// a single import.
import crypto from 'crypto';
import { assertPublicHost, guardedFetch, SSRFBlockedError } from '../lib/ssrf-guard.js';
import { db } from './core.js';

// -- Webhooks --

export function createWebhook(agentId, url, events, secret) {
  var eventsJson = Array.isArray(events) ? JSON.stringify(events) : (events || '["task_created","request_created","message_sent"]');
  var result = db.prepare(
    "INSERT INTO webhooks (agent_id, url, events, secret) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(agentId, url, eventsJson, secret || '');
  return result.id;
}

export function listWebhooks(agentId) {
  if (agentId) {
    return db.prepare("SELECT * FROM webhooks WHERE agent_id = ? AND active = 1").all(agentId);
  }
  return db.prepare("SELECT * FROM webhooks WHERE active = 1").all();
}

export function deleteWebhook(id) {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
}

export async function dispatchWebhook(event, agentId, data) {
  // Query webhooks for the target agent AND __global__ (admin-claude receives all events)
  var webhooks = db.prepare(
    "SELECT * FROM webhooks WHERE active = 1 AND (agent_id = ? OR agent_id = '__global__')"
  ).all(agentId);

  for (var wh of webhooks) {
    var events = [];
    try { events = JSON.parse(wh.events); } catch (e) { console.warn('[mycelium] JSON parse failed for webhook.events (webhook: ' + wh.id + '):', e.message); continue; }
    if (events.indexOf(event) === -1 && events.indexOf('*') === -1) continue;

    // Allow loopback if MYCELIUM_WEBHOOK_ALLOW_LOOPBACK is set to '1'. Declared at
    // loop-body scope so the redirect-guarded delivery below reuses the same flag
    // (the guardedFetch call sits outside the try, so a try-scoped const is undefined there).
    const allowLoopback = process.env.MYCELIUM_WEBHOOK_ALLOW_LOOPBACK === '1';

    // SSRF Guard: validate the webhook URL before making the request
    try {
      await assertPublicHost(wh.url, { allowLoopback });
    } catch (ssrfError) {
      if (ssrfError instanceof SSRFBlockedError) {
        // Log the SSRF attempt and skip delivery
        console.warn('[webhook] SSRF attempt blocked for webhook ' + wh.id + ':', ssrfError.message);
        // Record the event for monitoring
        try {
          const payload = JSON.stringify({
            event: event,
            agent_id: agentId,
            data: data,
            timestamp: new Date().toISOString()
          });
          logWebhookDelivery(wh.id, event, agentId, payload, null, null, 'SSRF blocked: ' + ssrfError.message, 0);
        } catch (logError) {
          console.error('[webhook] Failed to log SSRF attempt:', logError.message);
        }
        continue; // Skip this webhook delivery
      } else {
        // Re-throw if it's not an SSRF error
        throw ssrfError;
      }
    }

    var payload = JSON.stringify({
      event: event,
      agent_id: agentId,
      data: data,
      timestamp: new Date().toISOString()
    });

    var headers = { 'Content-Type': 'application/json' };
    if (wh.secret) {
      var sig = crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
      headers['X-Webhook-Signature'] = sig;
    }

    var whId = wh.id;
    var startTime = Date.now();

    // Non-blocking fetch with 5s timeout and retry (up to 3 attempts).
    // guardedFetch re-runs the SSRF guard on every redirect hop so a public
    // first-hop can't 302 into an internal address.
    (function deliverWithRetry(url, opts, attempt) {
      guardedFetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(5000) }), { allowLoopback })
        .then(function (resp) {
          var duration = Date.now() - startTime;
          return resp.text().then(function (body) {
            logWebhookDelivery(whId, event, agentId, payload, resp.status, body.substring(0, 1000), null, duration);
          });
        }).catch(function (err) {
          var duration = Date.now() - startTime;
          // SSRF blocks (incl. a redirect to a private host) must NOT be retried.
          if (err instanceof SSRFBlockedError) {
            logWebhookDelivery(whId, event, agentId, payload, null, null, 'SSRF blocked: ' + err.message, duration);
            console.warn('[webhook] SSRF blocked for webhook ' + whId + ':', err.message);
            return;
          }
          if (attempt < 3) {
            var delay = Math.pow(2, attempt) * 1000; // 2s, 4s backoff
            setTimeout(function () { deliverWithRetry(url, opts, attempt + 1); }, delay);
          } else {
            logWebhookDelivery(whId, event, agentId, payload, null, null, err.message + ' (after 3 attempts)', duration);
            console.error('[webhook] Failed after 3 attempts to', url, ':', err.message);
          }
        });
    })(wh.url, { method: 'POST', headers: headers, body: payload }, 1);
  }
}

function logWebhookDelivery(webhookId, event, agentId, payload, statusCode, responseBody, error, durationMs) {
  try {
    db.prepare(
      "INSERT INTO webhook_deliveries (webhook_id, event, agent_id, payload, status_code, response_body, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(webhookId, event, agentId, payload, statusCode, responseBody, error, durationMs);
  } catch (e) {
    console.error('[webhook-log] Failed to log delivery:', e.message);
  }
}

export function listWebhookDeliveries(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.event) { where.push('event = ?'); params.push(filters.event); }
  if (filters.webhook_id) { where.push('webhook_id = ?'); params.push(filters.webhook_id); }
  if (filters.error_only) { where.push('error IS NOT NULL'); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM webhook_deliveries WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function pruneWebhookDeliveries(keepDays) {
  var days = keepDays || 7;
  var result = db.prepare("DELETE FROM webhook_deliveries WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
  return result.changes;
}
