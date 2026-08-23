import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  A2AAdapterError,
  a2aMessageToBeamIntent,
  beamAgentToA2ACard,
  beamResultToA2ATask,
  parseA2AMessage,
} from './adapter.js'

describe('A2A v1 compatibility adapter', () => {
  it('maps a current A2A v1 message into a bounded Beam conversation intent', () => {
    const mapped = a2aMessageToBeamIntent({
      from: 'alice@acme.beam.directory',
      to: 'buyer@partner.beam.directory',
      message: {
        messageId: 'msg-123',
        contextId: 'ctx-123',
        role: 'ROLE_USER',
        parts: [
          { text: 'Please confirm the order status.' },
          { data: { orderId: 'PO-42' }, mediaType: 'application/json' },
        ],
      },
    })

    assert.equal(mapped.intent, 'conversation.message')
    assert.equal(mapped.payload.message, 'Please confirm the order status.')
    assert.equal((mapped.payload.a2a as Record<string, unknown>).protocolVersion, '1.0')
  })

  it('normalizes unknown legacy fields and rejects raw bytes, unsafe URLs, and oversized payloads', () => {
    const normalized = parseA2AMessage({ messageId: 'm1', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hello' }] })
    assert.deepEqual(normalized.parts, [{ text: 'hello' }])
    assert.throws(
      () => parseA2AMessage({ messageId: 'm1', role: 'ROLE_USER', parts: [{ raw: 'AA==' }] }),
      (error) => error instanceof A2AAdapterError && error.code === 'INLINE_FILE_NOT_ALLOWED',
    )
    assert.throws(
      () => parseA2AMessage({ messageId: 'm1', role: 'ROLE_USER', parts: [{ url: 'http://files.example/document' }] }),
      (error) => error instanceof A2AAdapterError && error.code === 'UNSAFE_FILE_URL',
    )
    assert.throws(
      () => a2aMessageToBeamIntent({
        from: 'alice@acme.beam.directory',
        to: 'buyer@partner.beam.directory',
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'x'.repeat(3_000) }, { text: 'y'.repeat(3_000) }] },
      }),
      (error) => error instanceof A2AAdapterError && error.code === 'BEAM_PAYLOAD_TOO_LARGE',
    )
  })

  it('maps Beam success and policy denial into A2A task states', () => {
    const completed = beamResultToA2ATask({
      taskId: 'task-1',
      contextId: 'ctx-1',
      result: {
        nonce: 'nonce-1',
        success: true,
        timestamp: '2026-08-23T08:00:00.000Z',
        payload: { message: 'Order shipped', tracking: 'TRACK-1' },
      },
    })
    assert.equal(completed.status.state, 'TASK_STATE_COMPLETED')
    assert.equal(completed.artifacts?.[0]?.parts[0]?.text, 'Order shipped')

    const denied = beamResultToA2ATask({
      taskId: 'task-2',
      contextId: 'ctx-1',
      result: {
        nonce: 'nonce-2',
        success: false,
        timestamp: '2026-08-23T08:00:00.000Z',
        error: 'Partner is not allowed',
        errorCode: 'ACL_DENIED',
      },
    })
    assert.equal(denied.status.state, 'TASK_STATE_REJECTED')
  })

  it('creates an authenticated A2A v1 Agent Card without claiming unsupported streaming', () => {
    const card = beamAgentToA2ACard({
      agent: {
        beamId: 'buyer@acme.beam.directory',
        displayName: 'Buyer Agent',
        org: 'Acme GmbH',
        capabilities: ['conversation.message', 'purchase.status'],
      },
      a2aUrl: 'https://api.beam.directory/a2a/v1/buyer',
      providerUrl: 'https://acme.example',
      tenant: 'acme',
    })

    assert.equal(card.supportedInterfaces[0]?.protocolVersion, '1.0')
    assert.equal(card.supportedInterfaces[0]?.protocolBinding, 'HTTP+JSON')
    assert.equal(card.capabilities.streaming, false)
    assert.equal(card.securitySchemes.beamBearer.httpAuthSecurityScheme.scheme, 'Bearer')
    assert.equal(card.skills.length, 2)
  })
})
