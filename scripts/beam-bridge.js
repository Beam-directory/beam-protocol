#!/usr/bin/env node
/**
 * beam-bridge.js — Bridges Beam Protocol Intents to OpenClaw Gateway
 * 
 * Runs as a persistent daemon. Connects to Beam Directory as a specific agent,
 * receives intents, and forwards them to the local OpenClaw gateway via
 * the OpenAI-compatible HTTP API.
 * 
 * Usage: 
 *   BEAM_AGENT=jarvis OPENCLAW_PORT=18789 OPENCLAW_TOKEN=xxx node beam-bridge.js
 *   BEAM_AGENT=clara OPENCLAW_PORT=18794 OPENCLAW_TOKEN=clara-agent-2026 node beam-bridge.js
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// --- Config ---
const BEAM_AGENT = process.env.BEAM_AGENT || 'jarvis'
const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const OPENCLAW_PORT = process.env.OPENCLAW_PORT || '18789'
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || ''
const IDENTITIES_PATH = process.env.BEAM_IDENTITIES || resolve(
  process.env.HOME, '.openclaw/workspace/secrets/beam-identities.json'
)

// --- Dynamic imports (ESM) ---
async function main() {
  const { BeamClient } = await import('../packages/sdk-typescript/dist/client.js')
  
  // Load identity
  const identities = JSON.parse(readFileSync(IDENTITIES_PATH, 'utf8'))
  const identity = identities[BEAM_AGENT]
  if (!identity) {
    console.error(`❌ Identity not found for: ${BEAM_AGENT}`)
    console.error(`   Available: ${Object.keys(identities).join(', ')}`)
    process.exit(1)
  }

  const beamId = `${BEAM_AGENT}@coppen.beam.directory`
  console.log(`🌊 Beam Bridge starting...`)
  console.log(`   Agent: ${beamId}`)
  console.log(`   Directory: ${DIRECTORY_URL}`)
  console.log(`   OpenClaw: http://localhost:${OPENCLAW_PORT}`)

  // Register agent in directory
  const client = new BeamClient({
    identity,
    directoryUrl: DIRECTORY_URL
  })

  const capabilities = {
    jarvis: ['orchestration', 'email', 'calendar', 'memory', 'analytics', 'escalation-handler'],
    fischer: ['invoice-management', 'payment-tracking', 'customer-communication', 'escalation'],
    clara: ['sales-support', 'pipeline-management', 'hubspot', 'customer-service'],
    james: ['personal-assistant', 'calendar', 'email', 'tasks']
  }

  const displayNames = {
    jarvis: 'Jarvis — Chief of Staff',
    fischer: 'Marc Fischer — Forderungsmanagement',
    clara: 'Clara Sommer — Sales Support',
    james: 'James — Personal Assistant (Thilo)'
  }

  try {
    await client.register(
      displayNames[BEAM_AGENT] || BEAM_AGENT,
      capabilities[BEAM_AGENT] || []
    )
    console.log(`   ✅ Registered in directory`)
  } catch (err) {
    console.log(`   ⚠️ Registration: ${err.message} (may already be registered)`)
  }

  // Connect WebSocket
  await client.connect()
  console.log(`   ✅ WebSocket connected — listening for intents\n`)

  // Handle ALL intents — forward to OpenClaw
  client.on('*', async (frame, respond) => {
    const timestamp = new Date().toISOString()
    console.log(`\n📨 [${timestamp}] Intent received:`)
    console.log(`   From: ${frame.from}`)
    console.log(`   Intent: ${frame.intent}`)
    console.log(`   Params: ${JSON.stringify(frame.params || {})}`)

    try {
      // Forward to OpenClaw via the OpenAI-compatible chat API
      const message = formatIntentAsMessage(frame)
      const response = await forwardToOpenClaw(message)
      
      console.log(`   ✅ OpenClaw responded (${response.length} chars)`)
      
      respond({
        success: true,
        payload: {
          agentResponse: response,
          processedBy: BEAM_AGENT,
          processedAt: new Date().toISOString()
        }
      })
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`)
      respond({
        success: false,
        error: err.message,
        errorCode: 'GATEWAY_ERROR'
      })
    }
  })

  // Keep alive
  process.on('SIGINT', () => {
    console.log('\n🛑 Beam Bridge shutting down...')
    client.disconnect()
    process.exit(0)
  })
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Beam Bridge shutting down...')
    client.disconnect()
    process.exit(0)
  })
}

function formatIntentAsMessage(frame) {
  return `[Beam Intent from ${frame.from}]\n` +
    `Intent: ${frame.intent}\n` +
    `Params: ${JSON.stringify(frame.params || {}, null, 2)}\n\n` +
    `Bitte bearbeite diesen Intent und antworte mit dem Ergebnis.`
}

async function forwardToOpenClaw(message) {
  const url = `http://localhost:${OPENCLAW_PORT}/v1/chat/completions`
  const headers = {
    'Content-Type': 'application/json'
  }
  if (OPENCLAW_TOKEN) {
    headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: message }],
      stream: false
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenClaw API ${res.status}: ${text.substring(0, 200)}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || '(no response)'
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
