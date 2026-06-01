#!/usr/bin/env node
// Mycelium Discord Adapter
//
// Bridges Discord channels to Mycelium channels.
// Runs as an SDK agent that watches Discord events and relays
// messages bidirectionally.
//
// Usage:
//   MYCELIUM_AGENT_ID=discord-adapter \
//   MYCELIUM_API_KEY=dvk_... \
//   DISCORD_TOKEN=... \
//   node adapters/discord.js
//
// Optional env:
//   DISCORD_CHANNEL_MAP — JSON mapping Discord channel IDs to Mycelium channel IDs
//     e.g. '{"123456789":5,"987654321":6}'
//   DISCORD_PREFIX — command prefix for agent interaction (default: !mycelium)
//   MYCELIUM_API_URL — API URL (default: https://mycelium.fyi/api/mycelium)

import { MyceliumAgent } from '../src/index.js'

var DISCORD_TOKEN = process.env.DISCORD_TOKEN
var CHANNEL_MAP_ENV = process.env.DISCORD_CHANNEL_MAP
var PREFIX = process.env.DISCORD_PREFIX || '!mycelium'

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required')
  process.exit(1)
}

// Channel mapping: discord channel ID → mycelium channel ID
var channelMap = {}         // discord → mycelium
var reverseChannelMap = {}  // mycelium → discord

if (CHANNEL_MAP_ENV) {
  try {
    channelMap = JSON.parse(CHANNEL_MAP_ENV)
    for (var dId in channelMap) {
      reverseChannelMap[channelMap[dId]] = dId
    }
  } catch {
    console.error('Invalid DISCORD_CHANNEL_MAP JSON')
    process.exit(1)
  }
}

// ── Discord client (minimal, no discord.js dependency) ──────────

// Uses Discord Gateway API directly to avoid heavy dependencies.
// For production use, consider discord.js for richer features.

import { WebSocket } from 'ws' // ws is the only dependency

var ws = null
var heartbeatInterval = null
var sequenceNumber = null
var sessionId = null
var resumeUrl = null
var discordUserId = null

function connectDiscord() {
  var gatewayUrl = resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json'
  ws = new WebSocket(gatewayUrl)

  ws.on('open', function() {
    console.log('[discord] Connected to gateway')
  })

  ws.on('message', function(data) {
    var payload = JSON.parse(data.toString())
    handleGatewayEvent(payload)
  })

  ws.on('close', function(code) {
    console.log('[discord] Disconnected:', code)
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    // Reconnect after 5s
    setTimeout(connectDiscord, 5000)
  })

  ws.on('error', function(err) {
    console.error('[discord] WebSocket error:', err.message)
  })
}

function handleGatewayEvent(payload) {
  var op = payload.op
  var t = payload.t
  var d = payload.d

  if (payload.s !== null) sequenceNumber = payload.s

  switch (op) {
    case 10: // Hello
      startHeartbeat(d.heartbeat_interval)
      if (sessionId && sequenceNumber !== null) {
        // Resume
        wsSend({ op: 6, d: { token: DISCORD_TOKEN, session_id: sessionId, seq: sequenceNumber } })
      } else {
        // Identify
        wsSend({
          op: 2,
          d: {
            token: DISCORD_TOKEN,
            intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
            properties: { os: 'linux', browser: 'mycelium', device: 'mycelium' }
          }
        })
      }
      break

    case 11: // Heartbeat ACK
      break

    case 0: // Dispatch
      if (t === 'READY') {
        sessionId = d.session_id
        resumeUrl = d.resume_gateway_url
        discordUserId = d.user.id
        console.log('[discord] Ready as', d.user.username + '#' + d.user.discriminator)
      }
      if (t === 'MESSAGE_CREATE') {
        handleDiscordMessage(d)
      }
      break

    case 7: // Reconnect
      ws.close()
      break

    case 9: // Invalid session
      sessionId = null
      sequenceNumber = null
      setTimeout(function() { ws.close() }, 1000)
      break
  }
}

function startHeartbeat(interval) {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  // First heartbeat with jitter
  setTimeout(function() {
    wsSend({ op: 1, d: sequenceNumber })
  }, interval * Math.random())
  heartbeatInterval = setInterval(function() {
    wsSend({ op: 1, d: sequenceNumber })
  }, interval)
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

// ── Discord REST API (minimal) ──────────────────────────────────

var DISCORD_API = 'https://discord.com/api/v10'

async function sendDiscordMessage(channelId, content) {
  var res = await fetch(DISCORD_API + '/channels/' + channelId + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bot ' + DISCORD_TOKEN
    },
    body: JSON.stringify({ content: content })
  })
  if (!res.ok) {
    var err = await res.text()
    console.error('[discord] Send failed:', res.status, err)
  }
  return res.ok
}

// ── Mycelium Agent ──────────────────────────────────────────────

var agent = new MyceliumAgent({
  agentId: process.env.MYCELIUM_AGENT_ID || 'discord-adapter',
  apiKey: process.env.MYCELIUM_API_KEY,
  apiUrl: process.env.MYCELIUM_API_URL,
  runtime: 'sdk',
  llmBackend: '',
  llmModel: '',
  capabilities: ['channels', 'discord']
})

// Load channel map from Mycelium context on boot
async function loadChannelMap() {
  try {
    var ctx = await agent.getContext('discord-adapter', 'channel-map')
    if (ctx && ctx.data) {
      var data = typeof ctx.data === 'string' ? JSON.parse(ctx.data) : ctx.data
      // Merge with env-provided map (env takes priority)
      for (var dId in data) {
        if (!channelMap[dId]) {
          channelMap[dId] = data[dId]
          reverseChannelMap[data[dId]] = dId
        }
      }
      console.log('[mycelium] Loaded channel map:', Object.keys(channelMap).length, 'mappings')
    }
  } catch {}
}

// Save channel map to Mycelium context
async function saveChannelMap() {
  try {
    await agent.setContext('discord-adapter', 'channel-map', channelMap)
  } catch (err) {
    console.error('[mycelium] Failed to save channel map:', err.message)
  }
}

// ── Message Bridging ────────────────────────────────────────────

// Discord → Mycelium
async function handleDiscordMessage(msg) {
  // Ignore own messages
  if (msg.author.id === discordUserId) return
  // Ignore bot messages
  if (msg.author.bot) return

  var myceliumChannelId = channelMap[msg.channel_id]

  // Handle commands
  if (msg.content.startsWith(PREFIX)) {
    await handleCommand(msg)
    return
  }

  // If no channel mapping, skip
  if (!myceliumChannelId) return

  // Forward to Mycelium
  var content = msg.content
  if (msg.attachments && msg.attachments.length > 0) {
    var urls = msg.attachments.map(function(a) { return a.url })
    content += '\n[Attachments: ' + urls.join(', ') + ']'
  }

  try {
    await agent.sendMessage(null, content, {
      channelId: myceliumChannelId,
      metadata: JSON.stringify({
        source: 'discord',
        discord_message_id: msg.id,
        discord_channel_id: msg.channel_id,
        discord_user_id: msg.author.id,
        discord_user: msg.author.username,
        discord_avatar: 'https://cdn.discordapp.com/avatars/' + msg.author.id + '/' + msg.author.avatar + '.png'
      })
    })
  } catch (err) {
    console.error('[bridge] Discord→Mycelium error:', err.message)
  }
}

// Mycelium → Discord (called from message handler)
async function bridgeToDiscord(msg) {
  // Don't echo messages that came from Discord
  if (msg.metadata) {
    var meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata
    if (meta.source === 'discord') return
  }

  var discordChannelId = reverseChannelMap[msg.channel_id]
  if (!discordChannelId) return

  // Format: [AgentName] message content
  var prefix = msg.from_agent ? '[' + msg.from_agent + '] ' : ''
  await sendDiscordMessage(discordChannelId, prefix + msg.content)
}

// ── Commands ────────────────────────────────────────────────────

async function handleCommand(msg) {
  var args = msg.content.slice(PREFIX.length).trim().split(/\s+/)
  var cmd = args[0]

  switch (cmd) {
    case 'link': {
      // !mycelium link <mycelium-channel-id>
      var mChannelId = parseInt(args[1])
      if (isNaN(mChannelId)) {
        await sendDiscordMessage(msg.channel_id, 'Usage: ' + PREFIX + ' link <mycelium-channel-id>')
        return
      }
      channelMap[msg.channel_id] = mChannelId
      reverseChannelMap[mChannelId] = msg.channel_id
      await saveChannelMap()
      await sendDiscordMessage(msg.channel_id, 'Linked this Discord channel to Mycelium channel #' + mChannelId)
      break
    }

    case 'unlink': {
      var existing = channelMap[msg.channel_id]
      if (existing) {
        delete reverseChannelMap[existing]
        delete channelMap[msg.channel_id]
        await saveChannelMap()
        await sendDiscordMessage(msg.channel_id, 'Unlinked this Discord channel from Mycelium')
      } else {
        await sendDiscordMessage(msg.channel_id, 'This channel is not linked to Mycelium')
      }
      break
    }

    case 'status': {
      var linked = channelMap[msg.channel_id]
      var mapCount = Object.keys(channelMap).length
      var statusMsg = 'Mycelium Discord Adapter\n'
        + 'Agent: ' + agent.agentId + '\n'
        + 'Linked channels: ' + mapCount + '\n'
        + 'This channel: ' + (linked ? 'linked to Mycelium #' + linked : 'not linked')
      await sendDiscordMessage(msg.channel_id, statusMsg)
      break
    }

    case 'say': {
      // !mycelium say <agent-id> <message>
      var targetAgent = args[1]
      var message = args.slice(2).join(' ')
      if (!targetAgent || !message) {
        await sendDiscordMessage(msg.channel_id, 'Usage: ' + PREFIX + ' say <agent-id> <message>')
        return
      }
      await agent.sendMessage(targetAgent, '[Discord/' + msg.author.username + '] ' + message)
      await sendDiscordMessage(msg.channel_id, 'Sent to ' + targetAgent)
      break
    }

    default:
      await sendDiscordMessage(msg.channel_id, 'Commands: link, unlink, status, say')
  }
}

// ── Polling for Mycelium → Discord messages ─────────────────────

var lastCheckedMessageId = {}

async function pollMyceliumChannels() {
  // For each linked Mycelium channel, check for new messages
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
        await bridgeToDiscord(msg)
        if (msg.id > lastCheckedMessageId[mChannelId]) lastCheckedMessageId[mChannelId] = msg.id
      }
    } catch (err) {
      console.error('[bridge] Mycelium→Discord poll error:', err.message)
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('[mycelium] Booting Discord adapter...')
  await agent.boot()
  await loadChannelMap()

  // Handle incoming Mycelium messages via heartbeat inbox
  agent.onMessage(async function(msg) {
    // If message is in a linked channel, bridge to Discord
    if (msg.channel_id && reverseChannelMap[msg.channel_id]) {
      await bridgeToDiscord(msg)
    }
  })

  // Start heartbeat + polling
  agent.start()

  // Poll Mycelium channels for new messages every 10s
  setInterval(pollMyceliumChannels, 10000)

  // Connect to Discord
  connectDiscord()

  console.log('[mycelium] Discord adapter running')
  console.log('[mycelium] Channel mappings:', Object.keys(channelMap).length)
  console.log('[mycelium] Use "' + PREFIX + ' link <channel-id>" in Discord to link channels')
}

main().catch(function(err) {
  console.error('Fatal:', err.message)
  process.exit(1)
})
