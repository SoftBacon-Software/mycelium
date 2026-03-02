// Gmail API email sender
// Port of wsac-agent/outreach/mailer.py

import { google } from 'googleapis';

/**
 * Send an email via Gmail API.
 * @param {object} config - { gmail_credentials (OAuth2 JSON), sender_email }
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Plain text body
 * @param {string} [bcc] - Optional BCC address
 * @returns {string} Gmail message ID
 */
export async function sendEmail(config, to, subject, body, bcc) {
  var gmail = await getGmailService(config);

  // Build RFC 2822 message
  var headers = [
    'To: ' + to,
    'From: ' + config.sender_email,
    'Subject: ' + subject,
    'Content-Type: text/plain; charset=utf-8'
  ];
  if (bcc) headers.push('Bcc: ' + bcc);
  var rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
  var encoded = Buffer.from(rawMessage).toString('base64url');

  var result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded }
  });

  return result.data.id;
}

/**
 * Check inbox for replies matching tracked contacts.
 * @param {object} config - Gmail config
 * @param {Array} sentEmails - Array of email addresses we've sent to
 * @param {number} sinceHours - How far back to search (default 24)
 * @returns {Array} Matched replies with { email, subject, snippet }
 */
export async function checkReplies(config, sentEmails, sinceHours) {
  var gmail = await getGmailService(config);
  sinceHours = sinceHours || 24;

  var query = 'is:inbox newer_than:' + sinceHours + 'h';
  var listResult = await gmail.users.messages.list({ userId: 'me', q: query });
  var messages = listResult.data.messages || [];

  var emailSet = new Set(sentEmails.map(function (e) { return e.toLowerCase(); }));
  var matched = [];

  for (var msgRef of messages) {
    try {
      var msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id });
      var sender = extractHeader(msg.data, 'From');
      var senderEmail = extractEmail(sender);
      if (!senderEmail || !emailSet.has(senderEmail.toLowerCase())) continue;

      matched.push({
        email: senderEmail,
        subject: extractHeader(msg.data, 'Subject'),
        snippet: msg.data.snippet || ''
      });
    } catch (e) {
      // Skip unreadable messages
    }
  }

  return matched;
}

/**
 * Check if we can send today (under daily limit).
 */
export function canSendToday(dailyCount, maxPerDay) {
  return dailyCount < (maxPerDay || 10);
}

/**
 * Check if now is within the optimal send window.
 * Tuesday-Thursday, 10 AM - 12 PM in recipient timezone.
 */
export function isSendWindow() {
  var now = new Date();
  var day = now.getDay(); // 0=Sun, 2=Tue, 3=Wed, 4=Thu
  if (day < 2 || day > 4) return false;
  var hour = now.getHours();
  return hour >= 10 && hour < 12;
}

// -- Internal helpers --

async function getGmailService(config) {
  var credentials = config.gmail_credentials;
  if (!credentials) throw new Error('gmail_credentials required in campaign config');

  var creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
  var auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret
  );
  auth.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token
  });

  return google.gmail({ version: 'v1', auth: auth });
}

function extractHeader(msg, name) {
  var headers = (msg.payload && msg.payload.headers) || [];
  for (var h of headers) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h.value || '';
  }
  return '';
}

function extractEmail(fromStr) {
  if (!fromStr) return '';
  var match = fromStr.match(/<([^>]+)>/);
  return match ? match[1] : fromStr;
}
