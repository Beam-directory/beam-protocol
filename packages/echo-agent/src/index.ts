import { createServer, type Server } from 'node:http'
import { BeamClient, BeamIdentity, type BeamIdentityData } from 'beam-protocol-sdk'

const ECHO_BEAM_ID = 'echo@beam.directory'
const ECHO_DISPLAY_NAME = 'Beam Echo Agent'
const ECHO_CAPABILITIES = ['conversation.message', 'booking.create', 'booking.cancel', 'booking.status', 'agent.ping']

const directoryUrl = process.env['BEAM_DIRECTORY_URL'] ?? 'http://localhost:3100'
const registrationSecret = process.env['ECHO_AGENT_SECRET']?.trim() || undefined
const port = Number.parseInt(process.env['PORT'] ?? '8788', 10)

const state = {
  beamId: ECHO_BEAM_ID,
  directoryUrl,
  registered: false,
  connected: false,
  startedAt: new Date().toISOString(),
  lastRegistrationAt: null as string | null,
  lastConnectionAt: null as string | null,
}

function createIdentity(): BeamIdentityData {
  return BeamIdentity.generate({ agentName: 'echo' }).export()
}

async function registerEchoAgent(identity: BeamIdentityData): Promise<void> {
  const response = await fetch(new URL('/agents/register', directoryUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(registrationSecret ? { Authorization: `Bearer ${registrationSecret}` } : {}),
    },
    body: JSON.stringify({
      beamId: ECHO_BEAM_ID,
      displayName: ECHO_DISPLAY_NAME,
      capabilities: ECHO_CAPABILITIES,
      publicKey: identity.publicKeyBase64,
      org: 'personal',
    }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error ?? `Echo agent registration failed with ${response.status}`)
  }

  await response.json().catch(() => ({}))

  state.registered = true
  state.lastRegistrationAt = new Date().toISOString()
}

function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.url !== '/echo/health') {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ status: 'not_found' }))
      return
    }

    res.statusCode = state.connected ? 200 : 503
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      status: state.connected ? 'ok' : 'starting',
      beamId: state.beamId,
      directoryUrl: state.directoryUrl,
      registered: state.registered,
      connected: state.connected,
      startedAt: state.startedAt,
      lastRegistrationAt: state.lastRegistrationAt,
      lastConnectionAt: state.lastConnectionAt,
    }))
  })
}

async function main(): Promise<void> {
  const identity = createIdentity()
  const client = new BeamClient({ identity, directoryUrl })
  const healthServer = createHealthServer()

  client.onTalk(async (message, from, respond) => {
    console.log(`[echo-agent] conversation.message from ${from}: ${message}`)
    respond(`Echo: ${message}`)
  })

  client.on('*', async (frame, respond) => {
    if (frame.intent === 'conversation.message') {
      return
    }

    console.log(`[echo-agent] mock success for ${frame.intent} from ${frame.from}`)
    respond({
      success: true,
      payload: {
        ok: true,
        beamId: client.beamId,
        handledBy: ECHO_BEAM_ID,
        intent: frame.intent,
        message: `Mock success for ${frame.intent}`,
        originalPayload: frame.payload ?? {},
      },
    })
  })

  await registerEchoAgent(identity)
  await client.connect()
  state.connected = true
  state.lastConnectionAt = new Date().toISOString()

  healthServer.listen(port, () => {
    console.log(`[echo-agent] health endpoint listening on http://localhost:${port}/echo/health`)
  })

  console.log(`[echo-agent] connected as ${client.beamId} -> ${directoryUrl}`)

  const shutdown = (signal: string) => {
    console.log(`[echo-agent] received ${signal}, shutting down`)
    state.connected = false
    client.disconnect()
    healthServer.close(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[echo-agent] fatal startup error:', error)
  process.exit(1)
})
