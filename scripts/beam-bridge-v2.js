#!/usr/bin/env node

import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BEAM_AGENT = process.env.BEAM_AGENT || 'jarvis'
const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const OPENCLAW_PORT = Number(process.env.OPENCLAW_PORT || '18789')
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || ''
const HEALTH_PORT = Number(process.env.HEALTH_PORT || String(OPENCLAW_PORT + 1000))
const IDENTITIES_PATH = process.env.BEAM_IDENTITIES || resolve(
  process.env.HOME || '',
  '.openclaw/workspace/secrets/beam-identities.json'
)
const DB_PATH = resolve(process.cwd(), 'beam-intents.db')

const capabilities = {
  jarvis: ['orchestration', 'email', 'calendar', 'memory', 'analytics', 'escalation-handler'],
  fischer: ['invoice-management', 'payment-tracking', 'customer-communication', 'escalation'],
  clara: ['sales-support', 'pipeline-management', 'hubspot', 'customer-service'],
  james: ['personal-assistant', 'calendar', 'email', 'tasks'],
}

const displayNames = {
  jarvis: 'Jarvis — Chief of Staff',
  fischer: 'Marc Fischer — Forderungsmanagement',
  clara: 'Clara Sommer — Sales Support',
  james: 'James — Personal Assistant (Thilo)',
}

const state = {
  startedAt: Date.now(),
  connected: false,
  shuttingDown: false,
  lastIntent: null,
  reconnectDelayMs: 1000,
  client: null,
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS intent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    intent TEXT NOT NULL,
    success INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    error TEXT
  )
`)

const insertLogStmt = db.prepare(`
  INSERT INTO intent_logs (timestamp, from_agent, to_agent, intent, success, latency_ms, error)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

const healthServer = createServer((req, res) => {
  if (!req.url || req.method !== 'GET' || !req.url.startsWith('/healthz')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
    return
  }

  const payload = {
    agent: BEAM_AGENT,
    connected: state.connected,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    lastIntent: state.lastIntent,
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
})

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[bridge-v2] health endpoint listening on http://localhost:${HEALTH_PORT}/healthz`)
})

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

async function shutdown(signal) {
  if (state.shuttingDown) return
  state.shuttingDown = true
  state.connected = false

  console.log(`[bridge-v2] received ${signal}, shutting down`)

  try {
    if (state.client) state.client.disconnect()
  } catch (err) {
    console.error('[bridge-v2] disconnect error:', err instanceof Error ? err.message : String(err))
  }

  await new Promise((resolveClose) => {
    healthServer.close(() => resolveClose())
  })

  try {
    db.close()
  } catch (err) {
    console.error('[bridge-v2] db close error:', err instanceof Error ? err.message : String(err))
  }

  process.exit(0)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function loadIdentity() {
  const identities = JSON.parse(readFileSync(IDENTITIES_PATH, 'utf8'))
  const identity = identities[BEAM_AGENT]
  if (!identity) {
    throw new Error(`Identity not found for ${BEAM_AGENT}. Available: ${Object.keys(identities).join(', ')}`)
  }
  return identity
}

function formatIntentAsMessage(frame) {
  return `[Beam Intent from ${frame.from}]\n` +
    `Intent: ${frame.intent}\n` +
    `Params: ${JSON.stringify(frame.params || {}, null, 2)}\n\n` +
    'Bitte bearbeite diesen Intent und antworte mit dem Ergebnis.'
}

async function forwardToOpenClaw(message) {
  const url = `http://localhost:${OPENCLAW_PORT}/v1/chat/completions`
  const headers = { 'Content-Type': 'application/json' }
  if (OPENCLAW_TOKEN) headers.Authorization = `Bearer ${OPENCLAW_TOKEN}`

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
    })
  } catch (err) {
    throw new Error(`OpenClaw gateway unreachable on port ${OPENCLAW_PORT}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenClaw API ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || '(no response)'
}

async function createConnectedClient() {
  const { BeamClient } = await import('../packages/sdk-typescript/dist/client.js')

  const identity = loadIdentity()
  const client = new BeamClient({
    identity,
    directoryUrl: DIRECTORY_URL,
  })

  try {
    await client.register(
      displayNames[BEAM_AGENT] || BEAM_AGENT,
      capabilities[BEAM_AGENT] || []
    )
  } catch (err) {
    console.log(`[bridge-v2] register warning: ${err instanceof Error ? err.message : String(err)}`)
  }

  await client.connect()
  return client
}

function setupIntentHandler(client) {
  client.on('*', async (frame, respond) => {
    const started = Date.now()
    const timestamp = new Date().toISOString()
    state.lastIntent = timestamp

    console.log(`[bridge-v2] intent ${frame.intent} from ${frame.from}`)

    let success = false
    let error = null

    try {
      const response = await forwardToOpenClaw(formatIntentAsMessage(frame))
      success = true

      respond({
        success: true,
        payload: {
          agentResponse: response,
          processedBy: BEAM_AGENT,
          processedAt: new Date().toISOString(),
        },
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      respond({
        success: false,
        error,
        errorCode: 'GATEWAY_ERROR',
      })
    } finally {
      const latencyMs = Date.now() - started
      try {
        insertLogStmt.run(
          timestamp,
          String(frame.from || ''),
          String(frame.to || ''),
          String(frame.intent || ''),
          success ? 1 : 0,
          latencyMs,
          error
        )
      } catch (dbErr) {
        console.error('[bridge-v2] failed to persist intent log:', dbErr instanceof Error ? dbErr.message : String(dbErr))
      }
    }
  })
}

async function monitorConnection(client) {
  while (!state.shuttingDown) {
    await sleep(1000)
    if (!client._ws || !client._wsConnected) {
      throw new Error('WebSocket disconnected')
    }
  }
}

async function run() {
  console.log(`[bridge-v2] starting agent=${BEAM_AGENT} directory=${DIRECTORY_URL} openclaw=http://localhost:${OPENCLAW_PORT}`)

  while (!state.shuttingDown) {
    try {
      const client = await createConnectedClient()
      state.client = client
      state.connected = true
      state.reconnectDelayMs = 1000

      console.log('[bridge-v2] connected and listening for intents')
      setupIntentHandler(client)

      await monitorConnection(client)
    } catch (err) {
      state.connected = false
      if (state.shuttingDown) break

      const message = err instanceof Error ? err.message : String(err)
      console.error(`[bridge-v2] connection error: ${message}`)
      console.log(`[bridge-v2] reconnecting in ${state.reconnectDelayMs}ms`)
      await sleep(state.reconnectDelayMs)
      state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 30_000)
    }
  }
}

run().catch(async (err) => {
  console.error('[bridge-v2] fatal:', err instanceof Error ? err.message : String(err))
  await shutdown('FATAL')
})
