#!/usr/bin/env node
// Mycelium Slack Adapter
//
// Bridges Slack channels to Mycelium channels using Slack's
// Socket Mode (no public URL needed).
//
// Usage:
//   MYCELIUM_AGENT_ID=slack-adapter \
//   MYCELIUM_API_KEY=dvk_... \
//   SLACK_BOT_TOKEN=xoxb-... \
//   SLACK_APP_TOKEN=xapp-... \
//   node adapters/slack.js
//
// Optional env:
//   SLACK_CHANNEL_MAP — JSON mapping Slack channel IDs to Mycelium channel IDs
//     e.g. '{"C01ABCDEF":5,"C02GHIJKL":6}'
//   MYCELIUM_API_URL — API URL (default: https://mycelium.fyi/api/mycelium)
//
// Slack App Setup:
//   1. Create app at api.slack.com/apps
//   2. Enable Socket Mode (generates xapp- token)
//   3. Add Bot Token Scopes: chat:write, channels:history, channels:read
//   4. Subscribe to events: message.channels
//   5. Install to workspace (generates xoxb- token)

import { MyceliumAgent } from '../src/index.js'
import { WebSocket } from 'ws'

var SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
var SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
var CHANNEL_MAP_ENV = process.env.SLACK_CHANNEL_MAP

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required')
  process.exit(1)
}

// Channel mapping
var channelMap = {}         // slack → mycelium
var reverseChannelMap = {}  // mycelium → slack
var botUserId = null

if (CHANNEL_MAP_ENV) {
  try {
    channelMap = JSON.parse(CHANNEL_MAP_ENV)
    for (var sId in channelMap) {
      reverseChannelMap[channelMap[sId]] = sId
    }
  } catch {
    console.error('Invalid SLACK_CHANNEL_MAP JSON')
    process.exit(1)
  }
}

// ── Slack Socket Mode ───────────────────────────────────────────

var slackWs = null

async function connectSlack() {
  // Get WebSocket URL via Socket Mode
  var res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + SLACK_APP_TOKEN }
  })
  var data = await res.json()
  if (!data.ok) {
    console.error('[slack] Connection failed:', data.error)
    setTimeout(connectSlack, 5000)
    return
  }

  slackWs = new WebSocket(data.url)

  slackWs.on('open', function() {
    console.log('[slack] Socket Mode connected')
  })

  slackWs.on('message', function(raw) {
    var payload = JSON.parse(raw.toString())
    handleSlackEvent(payload)
  })

  slackWs.on('close', function() {
    console.log('[slack] Disconnected, reconnecting...')
    setTimeout(connectSlack, 5000)
  })

  slackWs.on('error', function(err) {
    console.error('[slack] WebSocket error:', err.message)
  })
}

function handleSlackEvent(payload) {
  // Acknowledge envelope
  if (payload.envelope_id) {
    slackWs.send(JSON.stringify({ envelope_id: payload.envelope_id }))
  }

  if (payload.type === 'events_api') {
    var event = payload.payload && payload.payload.event
    if (event && event.type === 'message' && !event.subtype) {
      handleSlackMessage(event)
    }
  }
}

// ── Slack REST API ──────────────────────────────────────────────

async function slackPost(endpoint, body) {
  var res = await fetch('https://slack.com/api/' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SLACK_BOT_TOKEN
    },
    body: JSON.stringify(body)
  })
  return res.json()
}

async function sendSlackMessage(channelId, text) {
  var result = await slackPost('chat.postMessage', {
    channel: channelId,
    text: text
  })
  if (!result.ok) {
    console.error('[slack] Send failed:', result.error)
  }
  return result.ok
}

async function getBotInfo() {
  var res = await fetch('https://slack.com/api/auth.test', {
    headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
  })
  var data = await res.json()
  if (data.ok) botUserId = data.user_id
  return data
}

// ── Mycelium Agent ──────────────────────────────────────────────

var agent = new MyceliumAgent({
  agentId: process.env.MYCELIUM_AGENT_ID || 'slack-adapter',
  apiKey: process.env.MYCELIUM_API_KEY,
  apiUrl: process.env.MYCELIUM_API_URL,
  runtime: 'sdk',
  llmBackend: '',
  llmModel: '',
  capabilities: ['channels', 'slack']
})

async function loadChannelMap() {
  try {
    var ctx = await agent.getContext('slack-adapter', 'channel-map')
    if (ctx && ctx.data) {
      var data = typeof ctx.data === 'string' ? JSON.parse(ctx.data) : ctx.data
      for (var sId in data) {
        if (!channelMap[sId]) {
          channelMap[sId] = data[sId]
          reverseChannelMap[data[sId]] = sId
        }
      }
      console.log('[mycelium] Loaded channel map:', Object.keys(channelMap).length, 'mappings')
    }
  } catch {}
}

async function saveChannelMap() {
  try {
    await agent.setContext('slack-adapter', 'channel-map', channelMap)
  } catch (err) {
    console.error('[mycelium] Failed to save channel map:', err.message)
  }
}

// ── Message Bridging ────────────────────────────────────────────

// Slack → Mycelium
async function handleSlackMessage(event) {
  // Ignore bot's own messages
  if (event.user === botUserId) return

  var myceliumChannelId = channelMap[event.channel]

  // Handle slash-style commands in messages
  if (event.text && event.text.startsWith('<@' + botUserId + '>')) {
    await handleMention(event)
    return
  }

  if (!myceliumChannelId) return

  try {
    await agent.sendMessage(null, event.text || '', {
      channelId: myceliumChannelId,
      metadata: JSON.stringify({
        source: 'slack',
        slack_message_ts: event.ts,
        slack_channel_id: event.channel,
        slack_user_id: event.user,
        slack_thread_ts: event.thread_ts || null
      })
    })
  } catch (err) {
    console.error('[bridge] Slack→Mycelium error:', err.message)
  }
}

// Mycelium → Slack
async function bridgeToSlack(msg) {
  if (msg.metadata) {
    var meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata
    if (meta.source === 'slack') return
  }

  var slackChannelId = reverseChannelMap[msg.channel_id]
  if (!slackChannelId) return

  var prefix = msg.from_agent ? '*[' + msg.from_agent + ']* ' : ''
  await sendSlackMessage(slackChannelId, prefix + msg.content)
}

// ── Bot Mentions ────────────────────────────────────────────────

async function handleMention(event) {
  var text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
  var args = text.split(/\s+/)
  var cmd = args[0]

  switch (cmd) {
    case 'link': {
      var mChannelId = parseInt(args[1])
      if (isNaN(mChannelId)) {
        await sendSlackMessage(event.channel, 'Usage: @bot link <mycelium-channel-id>')
        return
      }
      channelMap[event.channel] = mChannelId
      reverseChannelMap[mChannelId] = event.channel
      await saveChannelMap()
      await sendSlackMessage(event.channel, 'Linked to Mycelium channel #' + mChannelId)
      break
    }

    case 'unlink': {
      var existing = channelMap[event.channel]
      if (existing) {
        delete reverseChannelMap[existing]
        delete channelMap[event.channel]
        await saveChannelMap()
        await sendSlackMessage(event.channel, 'Unlinked from Mycelium')
      } else {
        await sendSlackMessage(event.channel, 'Not currently linked')
      }
      break
    }

    case 'status': {
      var linked = channelMap[event.channel]
      var mapCount = Object.keys(channelMap).length
      await sendSlackMessage(event.channel,
        '*Mycelium Slack Adapter*\n'
        + 'Agent: `' + agent.agentId + '`\n'
        + 'Linked channels: ' + mapCount + '\n'
        + 'This channel: ' + (linked ? 'linked to Mycelium #' + linked : 'not linked'))
      break
    }

    case 'say': {
      var targetAgent = args[1]
      var message = args.slice(2).join(' ')
      if (!targetAgent || !message) {
        await sendSlackMessage(event.channel, 'Usage: @bot say <agent-id> <message>')
        return
      }
      await agent.sendMessage(targetAgent, '[Slack/' + event.user + '] ' + message)
      await sendSlackMessage(event.channel, 'Sent to `' + targetAgent + '`')
      break
    }

    default:
      await sendSlackMessage(event.channel, 'Commands: link, unlink, status, say')
  }
}

// ── Polling for Mycelium → Slack messages ───────────────────────

var lastCheckedMessageId = {}

async function pollMyceliumChannels() {
  for (var mChannelId in reverseChannelMap) {
    try {
      var messages = await agent.api.get('/channels/' + mChannelId + '/messages?limit=10')
      if (!Array.isArray(messages)) continue

      // Initialize lastCheckedMessageId for this channel if not set
      if (lastCheckedMessageId[mChannelId] === undefined) {
        lastCheckedMessageId[mChannelId] = 0
      }

      for (var i = messages.length - 1; i >= 0; i--) {
        var msg = messages[i]
        if (msg.id <= lastCheckedMessageId[mChannelId]) continue
        if (msg.from_agent === agent.agentId) continue
        await bridgeToSlack(msg)
        if (msg.id > lastCheckedMessageId[mChannelId]) lastCheckedMessageId[mChannelId] = msg.id
      }
    } catch (err) {
      console.error('[bridge] Mycelium→Slack poll error:', err.message)
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('[mycelium] Booting Slack adapter...')

  await agent.boot()
  await loadChannelMap()
  await getBotInfo()

  agent.onMessage(async function(msg) {
    if (msg.channel_id && reverseChannelMap[msg.channel_id]) {
      await bridgeToSlack(msg)
    }
  })

  agent.start()
  setInterval(pollMyceliumChannels, 10000)

  await connectSlack()

  console.log('[mycelium] Slack adapter running')
  console.log('[mycelium] Channel mappings:', Object.keys(channelMap).length)
  console.log('[mycelium] Mention the bot with "link <channel-id>" to link channels')
}

main().catch(function(err) {
  console.error('Fatal:', err.message)
  process.exit(1)
})
