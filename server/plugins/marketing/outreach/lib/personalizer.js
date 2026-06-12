// Claude-powered pitch personalization
// Ported from Python worker scripts

import Anthropic from '@anthropic-ai/sdk';

// Pitch angles per creator archetype. Override via campaign persona_prompt for project-specific pitches.
var ARCHETYPE_ANGLES = {
  genre_specialist: 'The gameplay depth and what makes it stand out in the genre',
  hidden_gem: 'Everything at once: the full package. Include best details.',
  strategy_fan: 'The strategic depth and meaningful decision-making',
  tech_innovator: 'The technical innovation and what makes the approach unique',
  lets_play: 'The narrative arc and character relationships'
};

/**
 * Generate a personalized pitch for a contact using Claude.
 * @param {object} contact - Contact record from DB
 * @param {object} campaign - Campaign record with persona_prompt, game_facts, templates
 * @param {string} anthropicApiKey - Anthropic API key
 * @returns {object} { pitch_subject, pitch_body, personalized_hook, archetype_paragraph }
 */
export async function personalize(contact, campaign, anthropicApiKey) {
  var client = new Anthropic({ apiKey: anthropicApiKey });

  var archetype = contact.archetype || 'hidden_gem';
  var archetypeAngle = ARCHETYPE_ANGLES[archetype] || ARCHETYPE_ANGLES.hidden_gem;

  // Build prompt
  var contentRef = '';
  if (contact.last_content) {
    contentRef = contact.type === 'press'
      ? 'Their latest article is titled: "' + contact.last_content + '"'
      : 'Their latest video is titled: "' + contact.last_content + '"';
  }

  var prompt = (campaign.persona_prompt ? campaign.persona_prompt + '\n\n' : '') +
    'You are a pitch personalisation assistant.\n\n' +
    (campaign.game_facts || '') + '\n\n' +
    'Contact name: ' + contact.name + '\n' +
    'Archetype: ' + archetype + '\n' +
    'Outlet / channel: ' + contact.outlet + '\n' +
    contentRef + '\n\n' +
    'Archetype angle to emphasise: ' + archetypeAngle + '\n\n' +
    'Generate two fields as JSON (no markdown, no code fences):\n' +
    '1. "personalized_hook" — 1-2 sentences connecting the contact\'s latest content to the project. Be specific and genuine.\n' +
    '2. "archetype_paragraph" — 3-4 sentences tailored to the archetype angle above. Highlight the feature that would resonate most.\n\n' +
    'Return ONLY valid JSON with those two keys. No other text.';

  var personalizedHook = '';
  var archetypeParagraph = '';

  try {
    var response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    var text = response.content[0].text;
    var parsed = JSON.parse(text);
    personalizedHook = parsed.personalized_hook || '';
    archetypeParagraph = parsed.archetype_paragraph || '';
  } catch (e) {
    console.error('Claude personalization error:', e.message);
  }

  // Fill template
  var templates = {};
  try { templates = JSON.parse(campaign.templates || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for campaign.templates (campaign: ' + (campaign.id || 'unknown') + '):', e.message); }

  // Determine template key
  var templateKey = contact.type === 'creator'
    ? 'creator_' + (contact.tier || 't3').toLowerCase()
    : (contact.archetype || 'games_press');

  var template = templates[templateKey] || templates.default || { subject: '', body: '' };

  var firstName = contact.name ? contact.name.split(' ')[0] : '';

  var replacements = {
    first_name: firstName,
    name: contact.name,
    outlet_or_channel: contact.outlet,
    last_video_title: contact.last_content,
    last_article_title: contact.last_content,
    personalized_hook: personalizedHook,
    archetype_paragraph: archetypeParagraph
  };

  var subject = fillTemplate(template.subject || '', replacements);
  var body = fillTemplate(template.body || '', replacements);

  return {
    pitch_subject: subject,
    pitch_body: body,
    personalized_hook: personalizedHook,
    archetype_paragraph: archetypeParagraph
  };
}

function fillTemplate(str, replacements) {
  var result = str;
  for (var [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp('\\{' + key + '\\}', 'g'), value || '');
  }
  return result;
}
