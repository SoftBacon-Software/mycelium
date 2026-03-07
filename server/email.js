// =============== Mycelium — Transactional Email (Resend) ===============
// Core email infrastructure. Graceful degradation: if RESEND_KEY not set,
// logs warning and skips sends — never crashes.

import { Resend } from 'resend';

var resend = null;
var FROM_DEFAULT = 'Mycelium <noreply@mycelium.fyi>';
var REPLY_TO_DEFAULT = 'support@mycelium.fyi';

// ---- Colors (Mycelium earth-tone palette) ----
var COLORS = {
  bg: '#1A1612',
  surface: '#2A2420',
  card: '#332B25',
  primary: '#D4A847',
  text: '#F0E8DB',
  textMuted: '#A89F94',
  moss: '#7A9E7E',
  rust: '#C45B3E',
  teal: '#5E9EA0',
  border: '#4A3F37'
};

/**
 * Initialize Resend client from RESEND_KEY env var.
 * Returns true if configured, false if skipped.
 */
export function initEmail() {
  var key = process.env.RESEND_KEY;
  if (!key) {
    console.warn('[boot] email: RESEND_KEY not set — email disabled');
    return false;
  }
  resend = new Resend(key);
  process.stdout.write('[boot] email: Resend ready\n');
  return true;
}

/** Check if email sending is configured */
export function isEmailEnabled() {
  return resend !== null;
}

/**
 * Send an email via Resend. Never throws.
 * @returns {string|null} Message ID on success, null on failure/disabled
 */
export async function sendEmail({ to, subject, html, replyTo, from }) {
  if (!resend) return null;
  try {
    var result = await resend.emails.send({
      from: from || FROM_DEFAULT,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: html,
      reply_to: replyTo || REPLY_TO_DEFAULT
    });
    if (result.error) {
      console.error('[email] Resend error:', result.error);
      return null;
    }
    console.log('[email] sent to ' + to + ': ' + subject);
    return result.data?.id || null;
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return null;
  }
}

// ======== Shared HTML wrapper ========

function emailWrapper(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <!-- Header -->
  <tr><td style="padding:24px 32px;background:${COLORS.surface};border-radius:12px 12px 0 0;border-bottom:2px solid ${COLORS.primary};">
    <span style="font-size:20px;font-weight:700;color:${COLORS.primary};letter-spacing:1px;">MYCELIUM</span>
  </td></tr>
  <!-- Body -->
  <tr><td style="padding:32px;background:${COLORS.card};color:${COLORS.text};font-size:15px;line-height:1.6;">
    <h2 style="margin:0 0 20px;color:${COLORS.text};font-size:22px;font-weight:600;">${title}</h2>
    ${bodyHtml}
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:20px 32px;background:${COLORS.surface};border-radius:0 0 12px 12px;text-align:center;">
    <span style="color:${COLORS.textMuted};font-size:12px;">Mycelium &mdash; The distributed development platform</span><br>
    <a href="https://mycelium.fyi" style="color:${COLORS.teal};font-size:12px;text-decoration:none;">mycelium.fyi</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(text, url, color) {
  color = color || COLORS.primary;
  return `<div style="text-align:center;margin:28px 0;">
  <a href="${url}" style="display:inline-block;padding:12px 32px;background:${color};color:${COLORS.bg};font-weight:600;font-size:15px;text-decoration:none;border-radius:6px;">${text}</a>
</div>`;
}

function muted(text) {
  return `<p style="color:${COLORS.textMuted};font-size:13px;margin:16px 0 0;">${text}</p>`;
}

// ======== Email Templates ========

/** Waitlist confirmation email */
export function templateWaitlistConfirmation(name, email) {
  var greeting = name ? ('Hi ' + name + ',') : 'Hi there,';
  var html = emailWrapper('Welcome to the Waitlist', `
    <p>${greeting}</p>
    <p>Thanks for signing up for Mycelium. We received your request and you're on the list.</p>
    <p>We're onboarding customers one at a time to ensure a great experience. We'll reach out as soon as your instance is ready.</p>
    <p style="color:${COLORS.primary};font-weight:500;">What happens next:</p>
    <ul style="color:${COLORS.text};padding-left:20px;">
      <li>We review your request (usually within 24 hours)</li>
      <li>We'll provision your dedicated Mycelium instance</li>
      <li>You'll get an email with your dashboard URL and login credentials</li>
    </ul>
    ${muted("If you didn't sign up for Mycelium, you can safely ignore this email.")}
  `);
  return { to: email, subject: "You're on the Mycelium waitlist", html: html };
}

/** Instance ready notification */
export function templateInstanceReady(name, email, domain, dashboardUrl, username, tempPassword) {
  var greeting = name ? ('Hi ' + name + ',') : 'Hi there,';
  var html = emailWrapper('Your Instance is Ready', `
    <p>${greeting}</p>
    <p>Your Mycelium instance is live and ready to use.</p>
    <div style="background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:8px;padding:20px;margin:20px 0;">
      <p style="margin:0 0 8px;"><strong style="color:${COLORS.primary};">Dashboard:</strong> <a href="${dashboardUrl}" style="color:${COLORS.teal};text-decoration:none;">${dashboardUrl}</a></p>
      <p style="margin:0 0 8px;"><strong style="color:${COLORS.primary};">Username:</strong> <code style="background:${COLORS.bg};padding:2px 6px;border-radius:3px;color:${COLORS.text};">${username}</code></p>
      <p style="margin:0;"><strong style="color:${COLORS.primary};">Temporary Password:</strong> <code style="background:${COLORS.bg};padding:2px 6px;border-radius:3px;color:${COLORS.text};">${tempPassword}</code></p>
    </div>
    ${button('Open Dashboard', dashboardUrl)}
    <p><strong style="color:${COLORS.rust};">Please change your password</strong> after your first login.</p>
    ${muted('Your instance: ' + domain)}
  `);
  return { to: email, subject: 'Your Mycelium instance is ready', html: html };
}

/** Password reset email */
export function templatePasswordReset(email, displayName, resetUrl, expiresMinutes) {
  var greeting = displayName ? ('Hi ' + displayName + ',') : 'Hi,';
  var html = emailWrapper('Password Reset', `
    <p>${greeting}</p>
    <p>We received a request to reset your password. Click the button below to choose a new one:</p>
    ${button('Reset Password', resetUrl)}
    <p>This link expires in <strong>${expiresMinutes} minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
    ${muted("If the button doesn't work, copy and paste this URL into your browser:")}
    <p style="word-break:break-all;color:${COLORS.teal};font-size:13px;">${resetUrl}</p>
  `);
  return { to: email, subject: 'Reset your Mycelium password', html: html };
}

/** Support ticket confirmation (sent to customer) */
export function templateTicketConfirmation(email, name, ticketId, subject) {
  var greeting = name ? ('Hi ' + name + ',') : 'Hi,';
  var html = emailWrapper('We Received Your Request', `
    <p>${greeting}</p>
    <p>Thanks for reaching out. We've received your support request and our team is on it.</p>
    <div style="background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:8px;padding:20px;margin:20px 0;">
      <p style="margin:0 0 8px;"><strong style="color:${COLORS.primary};">Ticket #${ticketId}</strong></p>
      <p style="margin:0;color:${COLORS.text};">${subject}</p>
    </div>
    <p>We'll follow up by email when there's an update. Most issues are resolved within 24 hours.</p>
    ${muted('Reply to this email if you have additional details to share.')}
  `);
  return { to: email, subject: 'Ticket #' + ticketId + ': ' + subject, replyTo: 'support@mycelium.fyi', html: html };
}

/** Support ticket resolution (sent to customer) */
export function templateTicketResolution(email, name, ticketId, subject, resolution) {
  var greeting = name ? ('Hi ' + name + ',') : 'Hi,';
  var html = emailWrapper('Your Issue Has Been Resolved', `
    <p>${greeting}</p>
    <p>We've resolved your support request:</p>
    <div style="background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:8px;padding:20px;margin:20px 0;">
      <p style="margin:0 0 8px;"><strong style="color:${COLORS.primary};">Ticket #${ticketId}</strong>: ${subject}</p>
      ${resolution ? '<p style="margin:12px 0 0;color:' + COLORS.moss + ';"><strong>Resolution:</strong> ' + resolution + '</p>' : ''}
    </div>
    <p>If this doesn't fully address your issue, just reply to this email and we'll reopen it.</p>
    ${muted('Thank you for using Mycelium.')}
  `);
  return { to: email, subject: 'Resolved — Ticket #' + ticketId + ': ' + subject, replyTo: 'support@mycelium.fyi', html: html };
}

/** Operator alert email */
export function templateOperatorAlert(operatorEmail, operatorName, alertTitle, alertBody, actionUrl) {
  var greeting = operatorName ? ('Hey ' + operatorName + ',') : 'Hey,';
  var actionBlock = actionUrl ? button('View in Dashboard', actionUrl) : '';
  var html = emailWrapper(alertTitle, `
    <p>${greeting}</p>
    <div style="background:${COLORS.surface};border-left:3px solid ${COLORS.primary};padding:16px 20px;margin:16px 0;border-radius:0 6px 6px 0;">
      ${alertBody}
    </div>
    ${actionBlock}
    ${muted('This is an automated alert from your Mycelium instance.')}
  `);
  return { to: operatorEmail, subject: '[Mycelium] ' + alertTitle, html: html };
}
