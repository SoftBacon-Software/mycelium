// YouTube + Hunter.io contact discovery
// Ported from Python worker scripts

import { google } from 'googleapis';

// Creator archetypes for discovery classification.
// Override via campaign config archetype_keywords for project-specific targeting.
var ARCHETYPE_KEYWORDS = {
  genre_specialist: ['indie game', 'indie dev', 'game dev', 'solo dev', 'game development'],
  hidden_gem: ['hidden gem', 'you missed', 'underrated', 'overlooked', 'slept on'],
  strategy_fan: ['strategy', 'tactics', 'turn-based', 'deckbuilder', 'simulation'],
  tech_innovator: ['ai game', 'ai generated', 'procedural', 'machine learning', 'tech'],
  lets_play: ["let's play", 'playthrough', 'full game', 'story', 'narrative']
};

function classifyArchetype(title, description) {
  var text = (title + ' ' + description).toLowerCase();
  for (var [archetype, keywords] of Object.entries(ARCHETYPE_KEYWORDS)) {
    for (var kw of keywords) {
      if (text.includes(kw)) return archetype;
    }
  }
  return 'hidden_gem';
}

function assignTier(subscriberCount) {
  if (subscriberCount > 500000) return 'T1';
  if (subscriberCount >= 50000) return 'T2';
  return 'T3';
}

/**
 * Discover YouTube creator contacts matching search queries.
 * @param {object} config - Campaign config with youtube_api_key, queries, min_subs, max_subs
 * @param {function} findExisting - Function to check if a contact already exists (email or notes match)
 * @returns {Array} Contact objects ready for DB insertion
 */
export async function discoverCreators(config, findExisting) {
  var apiKey = config.youtube_api_key;
  if (!apiKey) throw new Error('youtube_api_key required in campaign config');

  var youtube = google.youtube({ version: 'v3', auth: apiKey });
  var queries = config.queries || [];
  var minSubs = config.min_subs || 20000;
  var maxSubs = config.max_subs || 500000;
  var contacts = [];
  var seenChannelIds = new Set();

  for (var q of queries) {
    var queryStr = typeof q === 'string' ? q : q.query;
    var maxResults = (typeof q === 'object' && q.max_results) || 10;

    var searchResp = await youtube.search.list({
      q: queryStr, type: 'channel', part: 'snippet', maxResults: maxResults
    });

    for (var item of (searchResp.data.items || [])) {
      var channelId = item.snippet.channelId;
      if (seenChannelIds.has(channelId)) continue;
      seenChannelIds.add(channelId);

      var channelResp = await youtube.channels.list({
        id: channelId, part: 'statistics,snippet'
      });

      if (!channelResp.data.items || !channelResp.data.items.length) continue;
      var channelData = channelResp.data.items[0];
      var subCount = parseInt(channelData.statistics.subscriberCount || '0');

      if (subCount < minSubs || subCount > maxSubs) continue;

      var title = channelData.snippet.title || '';
      var description = channelData.snippet.description || '';
      var archetype = classifyArchetype(title, description);
      var tier = assignTier(subCount);

      // Dedup check
      if (findExisting && findExisting('channel_id:' + channelId)) continue;

      contacts.push({
        type: 'creator',
        name: title,
        outlet: title,
        email: '',
        tier: tier,
        archetype: archetype,
        subscriber_count: subCount,
        status: 'discovered',
        notes: 'channel_id:' + channelId
      });
    }
  }

  return contacts;
}

/**
 * Discover press contacts via Hunter.io domain search.
 * @param {object} config - Campaign config with hunter_api_key, press_targets [{outlet, url, pitch_type}]
 * @param {function} findExisting - Function to check if a contact already exists by email
 * @returns {Array} Contact objects ready for DB insertion
 */
export async function discoverPress(config, findExisting) {
  var apiKey = config.hunter_api_key;
  if (!apiKey) throw new Error('hunter_api_key required in campaign config');

  var targets = config.press_targets || [];
  var contacts = [];
  var seenEmails = new Set();

  for (var target of targets) {
    var domain = target.url || target.domain;
    var outletName = target.outlet || domain;
    var pitchType = target.pitch_type || 'games_press';

    try {
      var resp = await fetch('https://api.hunter.io/v2/domain-search?domain=' + encodeURIComponent(domain) + '&api_key=' + apiKey);
      if (!resp.ok) continue;
      var data = await resp.json();
      var emails = (data.data && data.data.emails) || [];

      for (var entry of emails) {
        var email = entry.value || '';
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);

        if (findExisting && findExisting(email)) continue;

        var firstName = entry.first_name || '';
        var lastName = entry.last_name || '';
        var name = (firstName + ' ' + lastName).trim();

        contacts.push({
          type: 'press',
          name: name,
          outlet: outletName,
          email: email,
          tier: '',
          archetype: pitchType,
          subscriber_count: 0,
          status: 'discovered',
          notes: 'source:hunter.io domain:' + domain
        });
      }
    } catch (e) {
      console.error('Hunter.io error for ' + domain + ':', e.message);
    }
  }

  return contacts;
}
