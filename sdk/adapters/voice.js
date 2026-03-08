#!/usr/bin/env node
// Mycelium Voice Adapter
//
// Local voice interface for operators using Whisper for transcription
// and a TTS engine for responses. Runs as an SDK agent.
//
// Usage:
//   MYCELIUM_AGENT_ID=voice-adapter \
//   MYCELIUM_API_KEY=dvk_... \
//   node adapters/voice.js
//
// Optional env:
//   WHISPER_MODEL — Whisper model name (default: base.en)
//   WHISPER_PATH — path to whisper binary (default: whisper)
//   TTS_ENGINE — 'say' (macOS), 'espeak', 'piper', or 'none'
//   WAKE_WORD — wake word (default: 'mycelium')
//   MYCELIUM_API_URL — API URL

import { MyceliumAgent } from '../src/index.js'
import { spawn, execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

var WHISPER_MODEL = process.env.WHISPER_MODEL || 'base.en'
var WHISPER_PATH = process.env.WHISPER_PATH || 'whisper'
var TTS_ENGINE = process.env.TTS_ENGINE || (process.platform === 'darwin' ? 'say' : 'espeak')
var WAKE_WORD = process.env.WAKE_WORD || 'mycelium'

// ── Mycelium Agent ──────────────────────────────────────────────

var agent = new MyceliumAgent({
  agentId: process.env.MYCELIUM_AGENT_ID || 'voice-adapter',
  apiKey: process.env.MYCELIUM_API_KEY,
  apiUrl: process.env.MYCELIUM_API_URL,
  runtime: 'sdk',
  capabilities: ['voice']
})

// ── Audio Recording (using sox/rec) ─────────────────────────────

function recordAudio(durationSecs) {
  return new Promise(function(resolve, reject) {
    var tmpFile = join(tmpdir(), 'mycelium_voice_' + Date.now() + '.wav')

    console.log('[voice] Recording for ' + durationSecs + 's... (speak now)')

    var proc = spawn('rec', [
      tmpFile,
      'rate', '16000',
      'channels', '1',
      'trim', '0', String(durationSecs)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    proc.on('close', function(code) {
      if (code === 0 && existsSync(tmpFile)) {
        resolve(tmpFile)
      } else {
        reject(new Error('Recording failed (code ' + code + '). Install sox: brew install sox'))
      }
    })

    proc.on('error', function() {
      reject(new Error('rec command not found. Install sox: brew install sox'))
    })
  })
}

// ── Whisper Transcription ───────────────────────────────────────

function transcribe(audioFile) {
  return new Promise(function(resolve, reject) {
    console.log('[voice] Transcribing...')

    var proc = spawn(WHISPER_PATH, [
      audioFile,
      '--model', WHISPER_MODEL,
      '--output_format', 'txt',
      '--output_dir', tmpdir()
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    var stderr = ''
    proc.stderr.on('data', function(d) { stderr += d.toString() })

    proc.on('close', function(code) {
      // Clean up audio file
      try { unlinkSync(audioFile) } catch {}

      if (code !== 0) {
        reject(new Error('Whisper failed: ' + stderr.slice(0, 200)))
        return
      }

      // Read transcript
      var txtFile = audioFile.replace(/\.wav$/, '.txt')
      try {
        var text = require('fs').readFileSync(txtFile, 'utf-8').trim()
        try { unlinkSync(txtFile) } catch {}
        resolve(text)
      } catch {
        reject(new Error('Transcript file not found'))
      }
    })

    proc.on('error', function() {
      reject(new Error('whisper command not found. Install: pip install openai-whisper'))
    })
  })
}

// ── TTS ─────────────────────────────────────────────────────────

function speak(text) {
  if (!text || TTS_ENGINE === 'none') {
    console.log('[voice] Response: ' + text)
    return
  }

  console.log('[voice] Speaking: ' + text)

  try {
    if (TTS_ENGINE === 'say') {
      execSync('say ' + JSON.stringify(text), { timeout: 30000 })
    } else if (TTS_ENGINE === 'espeak') {
      execSync('espeak ' + JSON.stringify(text), { timeout: 30000 })
    } else if (TTS_ENGINE === 'piper') {
      var tmpFile = join(tmpdir(), 'mycelium_tts_' + Date.now() + '.wav')
      execSync('echo ' + JSON.stringify(text) + ' | piper --output_file ' + tmpFile, { timeout: 30000 })
      execSync('aplay ' + tmpFile, { timeout: 30000 })
      try { unlinkSync(tmpFile) } catch {}
    }
  } catch (err) {
    console.error('[voice] TTS error:', err.message)
  }
}

// ── Voice Command Processing ────────────────────────────────────

async function processCommand(text) {
  try {
    var result = await agent.api.post('/voice/command', { text: text })
    return result.response || 'No response'
  } catch (err) {
    return 'Error: ' + err.message
  }
}

// ── Main Loop ───────────────────────────────────────────────────

async function voiceLoop() {
  console.log('[voice] Listening for commands... (say "' + WAKE_WORD + '" to activate)')
  console.log('[voice] Press Ctrl+C to exit')
  console.log('')

  while (true) {
    try {
      // Record 5 seconds of audio
      var audioFile = await recordAudio(5)

      // Transcribe
      var text = await transcribe(audioFile)

      if (!text || text.length < 2) {
        continue
      }

      console.log('[voice] Heard: "' + text + '"')

      // Check for wake word
      if (!text.toLowerCase().includes(WAKE_WORD.toLowerCase())) {
        continue
      }

      // Process command
      speak('Processing.')
      var response = await processCommand(text)
      speak(response)
      console.log('')

    } catch (err) {
      if (err.message.includes('not found')) {
        console.error('[voice] ' + err.message)
        process.exit(1)
      }
      // Silently continue on recording errors (e.g., no speech detected)
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('[mycelium] Booting Voice adapter...')
  console.log('[mycelium] TTS engine: ' + TTS_ENGINE)
  console.log('[mycelium] Whisper model: ' + WHISPER_MODEL)

  await agent.boot()
  agent.start()

  await voiceLoop()
}

main().catch(function(err) {
  console.error('Fatal:', err.message)
  process.exit(1)
})
