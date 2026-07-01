// Content research for outreach contacts
// Ported from Python worker scripts

import { google } from 'googleapis';
import { assertPublicHost, SSRFBlockedError } from '../../../../lib/ssrf-guard.js';

var COUNTRY_TIMEZONE_MAP = {
  US: 'America/New_York', GB: 'Europe/London', AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland', CA: 'America/Toronto', DE: 'Europe/Berlin',
  FR: 'Europe/Paris', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', BR: 'America/Sao_Paulo',
  IN: 'Asia/Kolkata', SE: 'Europe/Stockholm', NL: 'Europe/Amsterdam',
  ES: 'Europe/Madrid', IT: 'Europe/Rome', MX: 'America/Mexico_City'
};

/**
 * Research a creator contact — fetch latest YouTube video and timezone.
 * @param {object} contact - Contact record from DB
 * @param {string} youtubeApiKey - YouTube Data API key
 * @returns {object} Fields to update: { last_content, metadata }
 */
export async function researchCreator(contact, youtubeApiKey) {
  var channelId = extractChannelId(contact.notes || '');
  if (!channelId) return {};

  var youtube = google.youtube({ version: 'v3', auth: youtubeApiKey });
  var result = {};
  var meta = {};

  // Fetch latest video
  try {
    var searchResp = await youtube.search.list({
      channelId: channelId, order: 'date', type: 'video', part: 'snippet', maxResults: 1
    });
    var items = searchResp.data.items || [];
    if (items.length) {
      var video = items[0];
      var videoId = video.id.videoId;
      result.last_content = video.snippet.title;
      meta.last_video_url = 'https://youtube.com/watch?v=' + videoId;
    }
  } catch (e) {
    console.error('YouTube search error:', e.message);
  }

  // Detect timezone from channel country
  try {
    var channelResp = await youtube.channels.list({ id: channelId, part: 'snippet' });
    var channelItems = channelResp.data.items || [];
    if (channelItems.length) {
      var country = channelItems[0].snippet.country || '';
      if (COUNTRY_TIMEZONE_MAP[country]) {
        meta.timezone = COUNTRY_TIMEZONE_MAP[country];
      }
    }
  } catch (e) {
    console.error('YouTube channel error:', e.message);
  }

  if (Object.keys(meta).length) {
    result.metadata = JSON.stringify(meta);
  }
  return result;
}

/**
 * Research a press contact — scrape latest article headline.
 * @param {object} contact - Contact record from DB
 * @returns {object} Fields to update: { last_content }
 */
export async function researchPress(contact) {
  var domain = extractDomain(contact.notes || '');
  if (!domain) return {};

  // SSRF guard: domain is parsed from contact.notes (DB-controlled). Resolve DNS
  // and block private/link-local/metadata addresses before fetching.
  var targetUrl = 'https://' + domain;
  try {
    await assertPublicHost(targetUrl);
  } catch (ssrfErr) {
    if (ssrfErr instanceof SSRFBlockedError) {
      console.warn('[outreach-researcher] SSRF blocked for domain:', domain, '—', ssrfErr.message);
      return { last_content: '(research blocked)', error: 'SSRF blocked' };
    }
    throw ssrfErr;
  }

  try {
    var resp = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return {};
    var html = await resp.text();

    // Simple headline extraction — look for first <h2> or <h3> text
    var match = html.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
    if (match && match[1].trim()) {
      return { last_content: match[1].trim() };
    }
  } catch (e) {
    console.error('Press research error for ' + domain + ':', e.message);
  }
  return {};
}

function extractChannelId(notes) {
  for (var part of notes.split(/\s+/)) {
    if (part.startsWith('channel_id:')) return part.split(':')[1];
  }
  return '';
}

function extractDomain(notes) {
  for (var part of notes.split(/\s+/)) {
    if (part.startsWith('domain:')) return part.split(':')[1];
  }
  return '';
}
