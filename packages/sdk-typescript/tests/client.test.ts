import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BeamClient } from '../src/client.js'
import { createIntentFrame, validateResultFrame } from '../src/frames.js'
import { BeamIdentity } from '../src/identity.js'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  readonly url: string
  readyState = 0
  sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) {
      throw new Error('Socket not open')
    }
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ type: 'close' })
  }

  emitOpen(): void {
    this.readyState = this.OPEN
    this.onopen?.({ type: 'open' })
  }

  emitMessage(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    this.onmessage?.({ data })
  }
}

function getLastSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error('Expected a mock WebSocket instance')
  }
  return socket
}

async function createConnectedClient() {
  const identity = BeamIdentity.generate({ agentName: 'receiver', orgName: 'acme' })
  const client = new BeamClient({ identity: identity.export(), directoryUrl: 'http://directory.test/' })
  const connectPromise = client.connect()
  const socket = getLastSocket()

  await Promise.resolve()
  socket.emitOpen()
  socket.emitMessage({ type: 'connected', beamId: identity.beamId })
  await connectPromise

  return { client, socket, identity }
}

describe('BeamClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    MockWebSocket.instances = []
    fetchMock.mockReset()
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('connect() opens the WebSocket and waits for the connected message', async () => {
    const identity = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://directory.test/' })

    const connectPromise = client.connect()
    const socket = getLastSocket()
    expect(socket.url).toBe('wss://directory.test/ws?beamId=alice%40acme.beam.directory')

    let resolved = false
    void connectPromise.then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    socket.emitOpen()
    socket.emitMessage({ type: 'connected', beamId: identity.beamId })
    await expect(connectPromise).resolves.toBeUndefined()
    expect(resolved).toBe(true)
  })

  it('send() delivers intents over WebSocket and resolves matching results', async () => {
    const { client, socket } = await createConnectedClient()

    const sendPromise = client.send('target@acme.beam.directory', 'agent.ping', { message: 'hello' }, 5_000)

    const outbound = JSON.parse(socket.sent[0]) as { type: string; frame: { nonce: string; intent: string } }
    expect(outbound.type).toBe('intent')
    expect(outbound.frame.intent).toBe('agent.ping')

    socket.emitMessage({
      type: 'result',
      frame: {
        v: '1',
        success: true,
        nonce: outbound.frame.nonce,
        timestamp: new Date().toISOString(),
        signature: 'not-validated-on-receive',
        payload: { status: 'ok' },
      },
    })

    await expect(sendPromise).resolves.toEqual(
      expect.objectContaining({ success: true, nonce: outbound.frame.nonce, payload: { status: 'ok' } }),
    )
  })

  it('on() invokes intent handlers and sends signed result frames', async () => {
    const { client, socket, identity } = await createConnectedClient()
    const sender = BeamIdentity.generate({ agentName: 'sender', orgName: 'acme' })
    const handled = vi.fn()

    client.on('task.delegate', async (frame, respond) => {
      handled(frame)
      respond({ success: true, payload: { accepted: true } })
    })

    const incomingFrame = createIntentFrame(
      {
        intent: 'task.delegate',
        from: sender.beamId,
        to: identity.beamId,
        payload: { task: 'Prepare brief', priority: 'medium' },
      },
      sender,
    )

    socket.emitMessage({
      type: 'intent',
      frame: incomingFrame,
      senderPublicKey: sender.publicKeyBase64,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ intent: 'task.delegate' }))
    const outbound = JSON.parse(socket.sent[0]) as { type: string; frame: Record<string, unknown> }
    expect(outbound.type).toBe('result')
    expect(outbound.frame.nonce).toBe(incomingFrame.nonce)
    expect(validateResultFrame(outbound.frame, identity.publicKeyBase64)).toEqual({ valid: true })
  })

  it('send() falls back to HTTP when WebSocket is not connected', async () => {
    const identity = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const client = new BeamClient({ identity: identity.export(), directoryUrl: 'http://directory.test/' })

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        v: '1',
        success: true,
        nonce: 'http-nonce',
        timestamp: new Date().toISOString(),
        signature: 'server-signature',
      }),
    })

    const result = await client.send('target@acme.beam.directory', 'agent.ping', { message: 'fallback' })
    expect(result).toEqual(expect.objectContaining({ success: true, nonce: 'http-nonce' }))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://directory.test/intents',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    )
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { intent: string; from: string; to: string }
    expect(requestBody.intent).toBe('agent.ping')
    expect(requestBody.from).toBe(identity.beamId)
    expect(requestBody.to).toBe('target@acme.beam.directory')
  })

  it('send() rejects when a WebSocket intent times out', async () => {
    vi.useFakeTimers()
    const { client } = await createConnectedClient()

    const pending = client.send('target@acme.beam.directory', 'agent.ping', { message: 'timeout' }, 250)
    const assertion = expect(pending).rejects.toThrow('Intent "agent.ping" timed out after 250ms')

    await vi.advanceTimersByTimeAsync(251)
    await assertion
  })

  it('disconnect() closes the socket and rejects pending requests', async () => {
    const { client, socket } = await createConnectedClient()

    const pending = client.send('target@acme.beam.directory', 'agent.ping', { message: 'bye' }, 5_000)
    expect(socket.sent).toHaveLength(1)

    client.disconnect()

    await expect(pending).rejects.toThrow('Client disconnected')
    expect(socket.readyState).toBe(3)
  })
})
