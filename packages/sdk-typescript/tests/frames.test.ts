import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_SIZE,
  REPLAY_WINDOW_MS,
  canonicalizeFrame,
  createIntentFrame,
  createResultFrame,
  signFrame,
  validateIntentFrame,
  validateResultFrame,
} from '../src/frames.js'
import { BeamIdentity } from '../src/identity.js'
import type { IntentFrame } from '../src/types.js'

describe('frames', () => {
  const sender = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
  const receiver = BeamIdentity.generate({ agentName: 'bob', orgName: 'acme' })

  it('createIntentFrame() signs a valid intent frame', () => {
    const frame = createIntentFrame(
      {
        intent: 'task.delegate',
        from: sender.beamId,
        to: receiver.beamId,
        payload: { task: 'Review proposal', priority: 'high' },
      },
      sender,
    )

    expect(frame.signature).toBeTruthy()
    expect(frame.v).toBe('1')
    expect(frame.nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(validateIntentFrame(frame, sender.publicKeyBase64)).toEqual({ valid: true })
  })

  it('signFrame() produces signatures that fail after tampering', () => {
    const frame: IntentFrame = {
      v: '1',
      intent: 'agent.ping',
      from: sender.beamId,
      to: receiver.beamId,
      payload: { message: 'hello' },
      nonce: BeamIdentity.generateNonce(),
      timestamp: new Date().toISOString(),
    }

    signFrame(frame, sender.export().privateKeyBase64)
    expect(validateIntentFrame(frame, sender.publicKeyBase64)).toEqual({ valid: true })

    frame.payload.message = 'tampered'
    expect(validateIntentFrame(frame, sender.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Signature verification failed',
    })
  })

  it('createResultFrame() signs a valid result frame', () => {
    const frame = createResultFrame(
      {
        nonce: BeamIdentity.generateNonce(),
        success: true,
        payload: { accepted: true, estimatedCompletion: 'soon' },
        latency: 25,
      },
      receiver,
    )

    expect(frame.signature).toBeTruthy()
    expect(validateResultFrame(frame, receiver.publicKeyBase64)).toEqual({ valid: true })
  })

  it('validateResultFrame() rejects tampered result frames', () => {
    const frame = createResultFrame(
      {
        nonce: BeamIdentity.generateNonce(),
        success: false,
        error: 'Denied',
        errorCode: 'ACCESS_DENIED',
      },
      receiver,
    )

    const tampered = { ...frame, error: 'Allowed now' }
    expect(validateResultFrame(tampered, receiver.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Signature verification failed',
    })
  })

  it('validateIntentFrame() rejects missing or malformed fields', () => {
    const validFrame = createIntentFrame(
      {
        intent: 'agent.introduce',
        from: sender.beamId,
        to: receiver.beamId,
        payload: { question: 'Who are you?' },
      },
      sender,
    )

    const cases: Array<[string, unknown, string]> = [
      ['non-object frame', null, 'Frame must be an object'],
      ['wrong protocol version', { ...validFrame, v: '2' }, 'Invalid protocol version'],
      ['missing intent', { ...validFrame, intent: '' }, 'Missing or empty intent'],
      ['invalid sender id', { ...validFrame, from: 'Alice@acme.beam.directory' }, 'Invalid from Beam ID'],
      ['invalid receiver id', { ...validFrame, to: 'bob@example.com' }, 'Invalid to Beam ID'],
      ['missing nonce', { ...validFrame, nonce: '' }, 'Missing nonce'],
      ['missing timestamp', { ...validFrame, timestamp: 123 }, 'Missing timestamp'],
      ['non-object payload', { ...validFrame, payload: [] }, 'Payload must be an object'],
      ['missing signature', { ...validFrame, signature: undefined }, 'Missing signature'],
    ]

    for (const [, frame, error] of cases) {
      expect(validateIntentFrame(frame, sender.publicKeyBase64)).toEqual({ valid: false, error })
    }
  })

  it('validateResultFrame() rejects missing required fields', () => {
    const frame = createResultFrame(
      {
        nonce: BeamIdentity.generateNonce(),
        success: true,
      },
      receiver,
    )

    expect(validateResultFrame({ ...frame, success: undefined }, receiver.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Missing success boolean',
    })
    expect(validateResultFrame({ ...frame, nonce: '' }, receiver.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Missing nonce',
    })
    expect(validateResultFrame({ ...frame, signature: undefined }, receiver.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Missing signature',
    })
  })

  it('enforces MAX_FRAME_SIZE for intent frames', () => {
    const oversizedFrame = createIntentFrame(
      {
        intent: 'system.broadcast',
        from: sender.beamId,
        to: receiver.beamId,
        payload: { message: 'x'.repeat(MAX_FRAME_SIZE) },
      },
      sender,
    )

    const result = validateIntentFrame(oversizedFrame, sender.publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`exceeds limit of ${MAX_FRAME_SIZE} bytes`)
  })

  it('enforces REPLAY_WINDOW_MS for old and future intent frames', () => {
    const oldTimestamp = new Date(Date.now() - REPLAY_WINDOW_MS - 1_000).toISOString()
    const futureTimestamp = new Date(Date.now() + REPLAY_WINDOW_MS + 1_000).toISOString()

    const oldFrame = signFrame(
      {
        v: '1',
        intent: 'agent.ping',
        from: sender.beamId,
        to: receiver.beamId,
        payload: { message: 'old' },
        nonce: BeamIdentity.generateNonce(),
        timestamp: oldTimestamp,
      },
      sender.export().privateKeyBase64,
    )
    const futureFrame = signFrame(
      {
        v: '1',
        intent: 'agent.ping',
        from: sender.beamId,
        to: receiver.beamId,
        payload: { message: 'future' },
        nonce: BeamIdentity.generateNonce(),
        timestamp: futureTimestamp,
      },
      sender.export().privateKeyBase64,
    )

    expect(validateIntentFrame(oldFrame, sender.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Frame timestamp outside replay window (±5 minutes)',
    })
    expect(validateIntentFrame(futureFrame, sender.publicKeyBase64)).toEqual({
      valid: false,
      error: 'Frame timestamp outside replay window (±5 minutes)',
    })
  })

  it('canonicalizeFrame() is stable regardless of key order', () => {
    const left = {
      payload: { z: 1, a: { d: 4, b: 2 } },
      nonce: '123',
      success: true,
      v: '1',
    }
    const right = {
      v: '1',
      success: true,
      nonce: '123',
      payload: { a: { b: 2, d: 4 }, z: 1 },
    }

    expect(canonicalizeFrame(left)).toBe(canonicalizeFrame(right))
    expect(canonicalizeFrame(left)).toBe('{"nonce":"123","payload":{"a":{"b":2,"d":4},"z":1},"success":true,"v":"1"}')
  })
})
