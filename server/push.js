// =============== MYCELIUM — Web Push Notifications ===============
import webpush from 'web-push';
import { listPushSubscriptions, deletePushSubscription } from './db.js';

var VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
var VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
var VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@mycelium.fyi';

var configured = false;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
  console.log('[push] Web Push configured');
} else {
  console.log('[push] VAPID keys not set — push notifications disabled');
}

// Events that warrant a push notification (high-signal only)
var NOTIFY_EVENTS = new Set([
  'approval_created',
  'approval_requested',
  'drone_job_failed',
  'bug_filed',
  'admin_frozen',
  'agent_offline',
  'directive_sent',
]);

export function shouldNotify(eventType) {
  return NOTIFY_EVENTS.has(eventType);
}

export async function sendPushToAll(payload) {
  if (!configured) return;

  var subs = listPushSubscriptions();
  if (subs.length === 0) return;

  var payloadStr = JSON.stringify(payload);

  await Promise.allSettled(subs.map(async function (sub) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription), payloadStr);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or unsubscribed — clean up
        deletePushSubscription(sub.endpoint);
      }
    }
  }));
}
