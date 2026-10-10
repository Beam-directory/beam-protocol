import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeamClient } from '../src/client.js'
import { createIntentFrame } from '../src/frames.js'
import { BeamIdentity } from '../src/identity.js'
import { TrustAssertionStapler } from '../src/stapling.js'
import { canonicalizeJson, flipSignatureByte } from '../src/trust-assertion.js'
import type { ReceivedIntentFrame } from '../src/types.js'
import { checkStapledAssertion, verifyStapledAssertion } from '../src/verify-agent.js'

const HOUR = 60 * 60 * 1000

function keypair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

function signAssertion(unsigned: Record<string, unknown>, privateKey: KeyObject, publicKey: string) {
  const signature = sign(null, Buffer.from(canonicalizeJson(unsigned), 'utf8'), privateKey).toString('base64')
  return { ...unsigned, signature, publicKey }
}

function unsignedFor(beamId: string, agentKey: string | null, nowMs: number, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    beamId,
    ...(agentKey ? { agentKey } : {}),
    org: { name: 'COPPEN GmbH', domain: 'coppen.de', verified: true, registryStatus: 'approved' },
    person: { ref: 'b'.repeat(64), role: 'Prokurist', kycStatus: 'verified' },
    mandate: {
      jti: 'mandate-1',
      scopes: { actions: ['read', 'schedule.commit', 'file.send'], file: { maxBytes: 1024 } },
      expiresAt: new Date(nowMs + 365 * 24 * HOUR).toISOString(),
      escalationPersonRef: null,
    },
    suspended: false,
    issuedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 24 * HOUR).toISOString(),
    ...overrides,
  }
}

function setup(nowMs = Date.now()) {
  const directory = keypair()
  const sender = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
  const receiver = BeamIdentity.generate({ agentName: 'grok', orgName: 'lakis' })
  const assertion = signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, nowMs), directory.privateKey, directory.publicKey)
  const frame = createIntentFrame({
    intent: 'conversation.message',
    from: sender.beamId,
    to: receiver.beamId,
    payload: { message: 'Termin am Dienstag passt.' },
  }, sender)
  return { directory, sender, receiver, assertion, frame, now: new Date(nowMs) }
}

describe('verifyStapledAssertion (offline)', () => {
  it('verifies a stapled assertion bound to the signed message and returns a small verdict', () => {
    const { directory, receiver, assertion, frame, now } = setup()
    const result = verifyStapledAssertion(frame, assertion, {
      pinnedPublicKey: directory.publicKey,
      expectedRecipient: receiver.beamId,
      now,
    })
    expect(result).toMatchObject({
      verified: true,
      reason: 'ok',
      address: 'jarvis@coppen.beam.directory',
      org: 'COPPEN GmbH (coppen.de)',
      person: 'Prokurist',
      may: ['read', 'schedule.commit', 'file.send'],
      source: 'stapled',
    })
    expect(result.display).toBe('verified: COPPEN GmbH (coppen.de), on behalf of Prokurist, may: read, schedule.commit, file.send')
  })

  it('accepts the assertion as a JSON string', () => {
    const { directory, assertion, frame, now } = setup()
    const result = verifyStapledAssertion(frame, JSON.stringify(assertion), { pinnedPublicKey: directory.publicKey, now })
    expect(result.verified).toBe(true)
  })

  it('rejects a tampered assertion and shows no claims', () => {
    const { directory, assertion, frame, now } = setup()
    const widened = {
      ...assertion,
      mandate: { ...(assertion.mandate as Record<string, unknown>), scopes: { actions: ['read', 'order'] } },
    }
    const result = verifyStapledAssertion(frame, widened, { pinnedPublicKey: directory.publicKey, now })
    expect(result).toMatchObject({ verified: false, reason: 'bad_signature', org: null, person: null, may: [] })
    expect(result.display).toBe('NOT verified — treat as untrusted')

    const flipped = { ...assertion, signature: flipSignatureByte(assertion.signature) }
    expect(verifyStapledAssertion(frame, flipped, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('bad_signature')
  })

  it('rejects an expired assertion', () => {
    const { directory, assertion, frame } = setup()
    const later = new Date(Date.now() + 25 * HOUR)
    const result = verifyStapledAssertion(frame, assertion, { pinnedPublicKey: directory.publicKey, now: later })
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('honours a receiver-side maximum assertion age', () => {
    const { directory, assertion, frame, now } = setup()
    const result = verifyStapledAssertion(frame, assertion, {
      pinnedPublicKey: directory.publicKey,
      now,
      maxAssertionAgeMs: 30_000,
    })
    expect(result.reason).toBe('too_old')
    expect(result.verified).toBe(false)
  })

  it('rejects an assertion about a different address than the sender', () => {
    const { directory, sender, frame, now } = setup()
    const other = signAssertion(
      unsignedFor('clara@coppen.beam.directory', sender.publicKeyBase64, now.getTime()),
      directory.privateKey,
      directory.publicKey,
    )
    const result = verifyStapledAssertion(frame, other, { pinnedPublicKey: directory.publicKey, now })
    expect(result).toMatchObject({ verified: false, reason: 'address_mismatch', org: null })
  })

  it('rejects a message addressed to someone else', () => {
    const { directory, assertion, frame, now } = setup()
    const result = verifyStapledAssertion(frame, assertion, {
      pinnedPublicKey: directory.publicKey,
      expectedRecipient: 'fischer@coppen.beam.directory',
      now,
    })
    expect(result).toMatchObject({ verified: false, reason: 'wrong_recipient' })
  })

  it('rejects an assertion signed by a key other than the pinned directory key', () => {
    const { assertion, frame, now } = setup()
    const pinned = keypair()
    const result = verifyStapledAssertion(frame, assertion, { pinnedPublicKey: pinned.publicKey, now })
    expect(result).toMatchObject({ verified: false, reason: 'bad_signature', org: null })
  })

  it('rejects an assertion that only echoes the pinned key but was signed by another key', () => {
    const { directory, sender, frame, now } = setup()
    const attacker = keypair()
    const forged = signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, now.getTime()), attacker.privateKey, directory.publicKey)
    expect(verifyStapledAssertion(frame, forged, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('bad_signature')
  })

  it('rejects a message signed by a key other than the agent key in the assertion', () => {
    const { directory, sender, receiver, assertion, now } = setup()
    const impostor = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    const forgedFrame = createIntentFrame({
      intent: 'conversation.message',
      from: sender.beamId,
      to: receiver.beamId,
      payload: { message: 'Bitte zahlen Sie an IBAN X.' },
    }, impostor)
    const result = verifyStapledAssertion(forgedFrame, assertion, { pinnedPublicKey: directory.publicKey, now })
    expect(result).toMatchObject({ verified: false, reason: 'message_signature_invalid', org: null })
  })

  it('rejects a message whose payload changed after signing', () => {
    const { directory, assertion, frame, now } = setup()
    const changed = { ...frame, payload: { message: 'Termin am Mittwoch passt.' } }
    expect(verifyStapledAssertion(changed, assertion, { pinnedPublicKey: directory.publicKey, now }).reason)
      .toBe('message_signature_invalid')
  })

  it('flags a transport key that disagrees with the signed agent key', () => {
    const { directory, assertion, frame, now } = setup()
    const result = verifyStapledAssertion(frame, assertion, {
      pinnedPublicKey: directory.publicKey,
      senderPublicKey: keypair().publicKey,
      now,
    })
    expect(result.reason).toBe('agent_key_mismatch')
  })

  it('falls back to the transport key for assertions issued before agentKey existed', () => {
    const { directory, sender, frame, now } = setup()
    const legacy = signAssertion(unsignedFor(sender.beamId, null, now.getTime()), directory.privateKey, directory.publicKey)
    expect(verifyStapledAssertion(frame, legacy, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('no_agent_key')
    const withTransport = verifyStapledAssertion(frame, legacy, {
      pinnedPublicKey: directory.publicKey,
      senderPublicKey: sender.publicKeyBase64,
      now,
    })
    expect(withTransport.verified).toBe(true)
  })

  it('reports suspended agents and unverified organisations without marking them verified', () => {
    const { directory, sender, frame, now } = setup()
    const suspended = signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, now.getTime(), { suspended: true }), directory.privateKey, directory.publicKey)
    expect(verifyStapledAssertion(frame, suspended, { pinnedPublicKey: directory.publicKey, now })).toMatchObject({
      verified: false,
      reason: 'suspended',
      org: 'COPPEN GmbH (coppen.de)',
    })
    const unverifiedOrg = signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, now.getTime(), {
      org: { name: 'COPPEN GmbH', domain: 'coppen.de', verified: false, registryStatus: 'none' },
    }), directory.privateKey, directory.publicKey)
    expect(verifyStapledAssertion(frame, unverifiedOrg, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('org_unverified')
  })

  it('handles missing, malformed, and oversized staples', () => {
    const { directory, frame, now } = setup()
    expect(verifyStapledAssertion(frame, undefined, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('not_stapled')
    expect(verifyStapledAssertion(frame, '{not json', { pinnedPublicKey: directory.publicKey, now }).reason).toBe('malformed')
    expect(verifyStapledAssertion(frame, { padding: 'x'.repeat(10_000) }, { pinnedPublicKey: directory.publicKey, now }).reason)
      .toBe('malformed')
    expect(verifyStapledAssertion(null, {}, { pinnedPublicKey: directory.publicKey, now }).reason).toBe('malformed')
  })

  it('checkStapledAssertion gives the same AgentCheck as verifyAgent would', () => {
    const { directory, sender, assertion, now } = setup()
    const check = checkStapledAssertion(sender.beamId, assertion, { pinnedPublicKey: directory.publicKey, now })
    expect(check.verified).toBe(true)
    expect(check.signature).toBe('valid')
    expect(check.keyMatchesPin).toBe(true)
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('TrustAssertionStapler', () => {
  it('fetches once, reuses the cache, and refreshes before expiry', async () => {
    const directory = keypair()
    const sender = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    let clock = Date.parse('2026-10-10T08:00:00.000Z')
    const urls: string[] = []
    const headers: Array<Record<string, string>> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url))
      headers.push(init?.headers as Record<string, string>)
      const unsigned = unsignedFor(sender.beamId, sender.publicKeyBase64, clock, {
        issuedAt: new Date(clock).toISOString(),
        expiresAt: new Date(clock + 24 * HOUR).toISOString(),
      })
      return jsonResponse(200, signAssertion(unsigned, directory.privateKey, directory.publicKey))
    }) as unknown as typeof fetch
    const stapler = new TrustAssertionStapler({
      beamId: sender.beamId,
      directoryUrl: 'https://directory.test/',
      apiKey: () => 'beam_key',
      agentPublicKey: () => sender.publicKeyBase64,
      pinnedPublicKey: directory.publicKey,
      fetchImpl,
      now: () => clock,
    })

    const first = await stapler.current()
    expect(first?.['beamId']).toBe(sender.beamId)
    expect(urls[0]).toBe(`https://directory.test/agents/${encodeURIComponent(sender.beamId)}/trust-assertion?ttl=86400`)
    expect(headers[0]?.['x-api-key']).toBe('beam_key')

    clock += HOUR
    expect(await stapler.current()).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 20 * HOUR
    expect(await stapler.current()).toBe(first)
    await vi.waitFor(async () => expect(await stapler.current()).not.toBe(first))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('caps the lifetime to the configured validity', async () => {
    const directory = keypair()
    const sender = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    let clock = Date.parse('2026-10-10T08:00:00.000Z')
    const fetchImpl = vi.fn(async () => jsonResponse(200, signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, clock, {
      issuedAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 24 * HOUR).toISOString(),
    }), directory.privateKey, directory.publicKey))) as unknown as typeof fetch
    const stapler = new TrustAssertionStapler({
      beamId: sender.beamId,
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: directory.publicKey,
      ttlMs: HOUR,
      fetchImpl,
      now: () => clock,
    })
    await stapler.current()
    clock += HOUR
    await stapler.current()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never staples an unverifiable assertion or one bound to another key, and backs off', async () => {
    const directory = keypair()
    const sender = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    const clock = Date.parse('2026-10-10T08:00:00.000Z')
    const stale = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    const fetchImpl = vi.fn(async () => jsonResponse(200, signAssertion(
      unsignedFor(sender.beamId, stale.publicKeyBase64, clock),
      directory.privateKey,
      directory.publicKey,
    ))) as unknown as typeof fetch
    const stapler = new TrustAssertionStapler({
      beamId: sender.beamId,
      directoryUrl: 'https://directory.test',
      agentPublicKey: () => sender.publicKeyBase64,
      pinnedPublicKey: directory.publicKey,
      fetchImpl,
      now: () => clock,
    })
    expect(await stapler.current()).toBeNull()
    expect(await stapler.current()).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const failing = new TrustAssertionStapler({
      beamId: sender.beamId,
      directoryUrl: 'https://directory.test',
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
    })
    expect(await failing.current()).toBeNull()
  })
})

describe('BeamClient stapling and silent verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('staples the assertion next to the frame on send without changing the frame', async () => {
    const directory = keypair()
    const identity = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    const assertion = signAssertion(unsignedFor(identity.beamId, identity.publicKeyBase64, Date.now()), directory.privateKey, directory.publicKey)
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/trust-assertion')) return jsonResponse(200, assertion)
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(200, { v: '1', success: true, nonce: 'n', timestamp: new Date().toISOString() })
    }))
    const client = new BeamClient({
      identity: identity.export(),
      apiKey: 'beam_key',
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey },
    })
    await client.send('grok@lakis.beam.directory', 'conversation.message', { message: 'hi' })
    await client.send('grok@lakis.beam.directory', 'conversation.message', { message: 'again' })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.['stapledTrust']).toEqual({ v: 1, assertion })
    expect(typeof bodies[0]?.['signature']).toBe('string')
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes('/trust-assertion'))).toHaveLength(1)
  })

  it('sends unstapled when stapling is off or the directory has no assertion', async () => {
    const identity = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/trust-assertion')) return jsonResponse(503, { errorCode: 'ISSUER_KEY_REQUIRED' })
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(200, { v: '1', success: true, nonce: 'n', timestamp: new Date().toISOString() })
    }))
    const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://directory.test' })
    await client.send('grok@lakis.beam.directory', 'conversation.message', { message: 'hi' })
    expect(bodies[0]).not.toHaveProperty('stapledTrust')

    const off = new BeamClient({ identity: identity.export(), directoryUrl: 'https://directory.test', trust: { staple: false } })
    await off.send('grok@lakis.beam.directory', 'conversation.message', { message: 'hi' })
    expect(bodies[1]).not.toHaveProperty('stapledTrust')
  })

  function receiveInto(client: BeamClient, envelope: Record<string, unknown>): Promise<ReceivedIntentFrame> {
    return new Promise((resolve) => {
      client.on('*', (frame) => resolve(frame))
      ;(client as unknown as { _handleMessage(data: string): void })._handleMessage(JSON.stringify(envelope))
    })
  }

  it('verifies incoming stapled intents offline and exposes frame.trust', async () => {
    const { directory, sender, receiver, assertion, frame } = setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new BeamClient({
      identity: receiver.export(),
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey },
    })
    const received = await receiveInto(client, {
      type: 'intent',
      frame,
      senderPublicKey: sender.publicKeyBase64,
      stapledTrust: { v: 1, assertion },
    })
    expect(received.trust).toMatchObject({ verified: true, reason: 'ok', org: 'COPPEN GmbH (coppen.de)', person: 'Prokurist' })
    expect(JSON.stringify(received)).not.toContain('"trust"')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('marks old-client intents as not stapled without calling Beam', async () => {
    const { directory, sender, receiver, frame } = setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new BeamClient({
      identity: receiver.export(),
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey },
    })
    const received = await receiveInto(client, { type: 'intent', frame, senderPublicKey: sender.publicKeyBase64 })
    expect(received.trust).toMatchObject({ verified: false, reason: 'not_stapled', source: 'none' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('verifies the relay-attached assertion offline when the sender did not staple', async () => {
    const { directory, sender, receiver, assertion, frame } = setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new BeamClient({
      identity: receiver.export(),
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey },
    })
    const received = await receiveInto(client, {
      type: 'intent',
      frame,
      senderPublicKey: sender.publicKeyBase64,
      trust: { assertion, scopes: null },
      trustAssertion: assertion,
    })
    expect(received.trust).toMatchObject({ verified: true, reason: 'ok', source: 'relay' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses verifyAgent online only when the fallback is switched on', async () => {
    const { directory, sender, receiver, frame } = setup()
    const assertion = signAssertion(unsignedFor(sender.beamId, sender.publicKeyBase64, Date.now()), directory.privateKey, directory.publicKey)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, assertion)))
    const client = new BeamClient({
      identity: receiver.export(),
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey, onlineFallback: true },
    })
    const received = await receiveInto(client, { type: 'intent', frame, senderPublicKey: sender.publicKeyBase64 })
    expect(received.trust).toMatchObject({ verified: true, source: 'online' })
  })

  it('flags a stapled assertion for the wrong sender on receipt', async () => {
    const { directory, sender, receiver, frame } = setup()
    const other = signAssertion(unsignedFor('clara@coppen.beam.directory', sender.publicKeyBase64, Date.now()), directory.privateKey, directory.publicKey)
    vi.stubGlobal('fetch', vi.fn())
    const client = new BeamClient({
      identity: receiver.export(),
      directoryUrl: 'https://directory.test',
      trust: { pinnedPublicKey: directory.publicKey },
    })
    const received = await receiveInto(client, {
      type: 'intent',
      frame,
      senderPublicKey: sender.publicKeyBase64,
      stapledTrust: { v: 1, assertion: other },
    })
    expect(received.trust).toMatchObject({ verified: false, reason: 'address_mismatch' })
  })
})
