import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/delivery.js', () => ({
  deliverToDirectory: vi.fn(async () => ({ success: true, error: '', retryable: false })),
}))

import { cleanTestMessages, getMessage, initDatabase, insertMessage, markAcked, markDeadLetter, markDelivered, markDispatched, markFailed, scheduleRetry } from '../src/db.js'
import { deliverToDirectory } from '../src/delivery.js'
import { createBusRouter } from '../src/router.js'
import { startRetryWorker, stopRetryWorker } from '../src/worker.js'

describe('message bus', () => {
  let app: Hono
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    db = initDatabase(':memory:')
    app = new Hono()
    app.route('/v1/beam', createBusRouter({ db, directoryUrl: 'http://directory.test', rateLimit: 10 }))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('roundtrips insertMessage + getMessage', () => {
    const id = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })

    const message = getMessage(db, id)
    expect(message?.id).toBe(id)
    expect(message?.nonce).toBeTruthy()
    expect(message?.sender).toBe('alpha@beam.directory')
    expect(JSON.parse(message?.payload ?? '{}')).toEqual({ text: 'hello' })
  })

  it('returns 201 from /send with a valid payload', async () => {
    const response = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alpha@beam.directory',
        to: 'beta@beam.directory',
        intent: 'chat',
        payload: { text: 'hello' },
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body['message_id']).toBeTypeOf('string')
    expect(body['nonce']).toBeTypeOf('string')
    expect(body['status']).toBe('delivered')
  })

  it('dedupes duplicate sends with the same nonce', async () => {
    const nonce = 'nonce-dedupe-1'
    const body = {
      from: 'alpha@beam.directory',
      to: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
      nonce,
    }

    const first = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const firstPayload = await first.json() as Record<string, unknown>

    const second = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(vi.mocked(deliverToDirectory)).toHaveBeenCalledTimes(1)
    expect(await second.json()).toEqual({
      message_id: firstPayload['message_id'],
      nonce,
      status: 'delivered',
      created_at: firstPayload['created_at'],
      retry_count: 0,
      deduped: true,
    })
  })

  it('rejects nonce reuse for a different message body', async () => {
    const nonce = 'nonce-conflict-1'

    const first = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alpha@beam.directory',
        to: 'beta@beam.directory',
        intent: 'chat',
        payload: { text: 'hello' },
        nonce,
      }),
    })

    const second = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alpha@beam.directory',
        to: 'beta@beam.directory',
        intent: 'chat',
        payload: { text: 'different' },
        nonce,
      }),
    })

    expect(first.status).toBe(201)
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({
      error: `Nonce ${nonce} already belongs to a different message`,
      errorCode: 'NONCE_REUSE_CONFLICT',
    })
  })

  it('returns 400 from /send with malformed JSON', async () => {
    const response = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' })
  })

  it('returns 400 from /send when required fields are missing', async () => {
    const response = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'alpha@beam.directory' }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body['errorCode']).toBe('MISSING_REQUIRED_FIELDS')
  })

  it('returns 400 from /send when payload is not an object', async () => {
    const response = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alpha@beam.directory',
        to: 'beta@beam.directory',
        intent: 'chat',
        payload: ['hello'],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'payload must be an object', errorCode: 'INVALID_PAYLOAD' })
  })

  it('returns an empty array from /poll when there are no messages', async () => {
    const response = await app.request('http://localhost/v1/beam/poll?agent=beta@beam.directory')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ messages: [], count: 0 })
  })

  it('returns delivered messages from /poll', async () => {
    const id = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hi' },
    })
    markDispatched(db, id)
    markDelivered(db, id)

    const response = await app.request('http://localhost/v1/beam/poll?agent=beta@beam.directory')

    expect(response.status).toBe(200)
    const body = await response.json() as { count: number; messages: Array<Record<string, unknown>> }
    expect(body.count).toBe(1)
    expect(body.messages[0]?.id).toBe(id)
    expect(body.messages[0]?.payload).toEqual({ text: 'hi' })
  })

  it('returns 400 from /poll when agent is missing', async () => {
    const response = await app.request('http://localhost/v1/beam/poll')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'agent query parameter is required', errorCode: 'MISSING_AGENT' })
  })

  it('acks a valid message_id', async () => {
    const id = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })
    markDispatched(db, id)
    markDelivered(db, id)

    const response = await app.request('http://localhost/v1/beam/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: id, status: 'acked', response: { ok: true } }),
    })

    expect(response.status).toBe(200)
    expect(getMessage(db, id)?.status).toBe('acked')
  })

  it('returns 404 when /ack receives an unknown message_id', async () => {
    const response = await app.request('http://localhost/v1/beam/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 'missing', status: 'acked' }),
    })

    expect(response.status).toBe(404)
    const body = await response.json() as Record<string, unknown>
    expect(body['errorCode']).toBe('MESSAGE_NOT_FOUND')
  })

  it('returns 400 when /ack receives malformed JSON', async () => {
    const response = await app.request('http://localhost/v1/beam/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' })
  })

  it('returns 400 when /ack receives an invalid status', async () => {
    const id = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })

    const response = await app.request('http://localhost/v1/beam/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: id, status: 'weird' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'status must be "acked" or "failed"', errorCode: 'INVALID_STATUS' })
  })

  it('returns 409 when /ack receives a message in the wrong lifecycle state', async () => {
    const id = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })

    const response = await app.request('http://localhost/v1/beam/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: id, status: 'acked' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: `Invalid message ${id} lifecycle transition from received to acked`,
      errorCode: 'INVALID_STATE',
    })
  })

  it('dead-letters non-retryable send failures immediately', async () => {
    vi.mocked(deliverToDirectory).mockResolvedValueOnce({
      success: false,
      error: 'Signature verification failed',
      errorCode: 'INVALID_INTENT',
      retryable: false,
      status: 400,
    })

    const response = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alpha@beam.directory',
        to: 'beta@beam.directory',
        intent: 'chat',
        payload: { text: 'hello' },
        nonce: 'dead-letter-now',
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body['status']).toBe('dead_letter')
    expect(getMessage(db, String(body['message_id']))?.status).toBe('dead_letter')
  })

  it('lists dead-lettered messages through the operator endpoint', async () => {
    const id = insertMessage(db, {
      nonce: 'dead-letter-list',
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })
    markDeadLetter(db, id, 'boom')

    const response = await app.request('http://localhost/v1/beam/dead-letter')

    expect(response.status).toBe(200)
    const body = await response.json() as { count: number; messages: Array<Record<string, unknown>> }
    expect(body.count).toBe(1)
    expect(body.messages[0]?.id).toBe(id)
    expect(body.messages[0]?.nonce).toBe('dead-letter-list')
    expect(body.messages[0]?.status).toBe('dead_letter')
  })

  it('requeues dead-lettered messages with the original nonce', async () => {
    const id = insertMessage(db, {
      nonce: 'requeue-nonce',
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
    })
    markDeadLetter(db, id, 'boom')

    const response = await app.request(`http://localhost/v1/beam/dead-letter/${id}/requeue`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      message_id: id,
      nonce: 'requeue-nonce',
      status: 'delivered',
      requeued: true,
    })
    expect(vi.mocked(deliverToDirectory)).toHaveBeenCalledWith(
      'http://directory.test',
      id,
      'requeue-nonce',
      'alpha@beam.directory',
      'beta@beam.directory',
      'chat',
      { text: 'hello' },
    )
  })

  it('returns correct counts from /stats', async () => {
    const deliveredId = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { seq: 1 },
    })
    const ackedId = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'gamma@beam.directory',
      intent: 'task.execute',
      payload: { seq: 2 },
    })
    const failedId = insertMessage(db, {
      sender: 'delta@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'notify',
      payload: { seq: 3 },
    })
    const pendingId = insertMessage(db, {
      sender: 'epsilon@beam.directory',
      recipient: 'zeta@beam.directory',
      intent: 'notify',
      payload: { seq: 4 },
    })

    markDispatched(db, deliveredId)
    markDelivered(db, deliveredId)
    markDispatched(db, ackedId)
    markDelivered(db, ackedId)
    markAcked(db, ackedId, { ok: true })
    markDispatched(db, failedId)
    markFailed(db, failedId, 'boom')
    scheduleRetry(db, pendingId, 1, (Date.now() / 1000) + 60, 'offline')

    expect(getMessage(db, pendingId)?.status).toBe('queued')

    const response = await app.request('http://localhost/v1/beam/stats')
    expect(response.status).toBe(200)

    const body = await response.json() as Record<string, unknown>
    expect(body['total']).toBe(4)
    expect(body['queued']).toBe(1)
    expect(body['received']).toBe(0)
    expect(body['dispatched']).toBe(0)
    expect(body['delivered']).toBe(1)
    expect(body['acked']).toBe(1)
    expect(body['failed']).toBe(1)
    expect(body['dead_letter']).toBe(0)
  })

  it('rate limits the 11th message from the same sender', async () => {
    for (let index = 0; index < 10; index += 1) {
      const response = await app.request('http://localhost/v1/beam/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: 'limited@beam.directory',
          to: `target-${index}@beam.directory`,
          intent: 'chat',
          payload: { seq: index },
        }),
      })

      expect(response.status).toBe(201)
    }

    const blocked = await app.request('http://localhost/v1/beam/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'limited@beam.directory',
        to: 'overflow@beam.directory',
        intent: 'chat',
        payload: { seq: 10 },
      }),
    })

    expect(blocked.status).toBe(429)
    const body = await blocked.json() as Record<string, unknown>
    expect(body['errorCode']).toBe('RATE_LIMIT_EXCEEDED')
  })

  it('removes test and demo messages from the database', () => {
    const keptId = insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { keep: true },
    })
    insertMessage(db, {
      sender: 'sender@test.example',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { drop: 'sender' },
    })
    insertMessage(db, {
      sender: 'alpha@beam.directory',
      recipient: 'recipient@demo.example',
      intent: 'chat',
      payload: { drop: 'recipient' },
    })

    expect(cleanTestMessages(db)).toBe(2)
    expect(getMessage(db, keptId)?.status).toBe('received')
  })

  it('retries queued messages with a stable nonce and dead-letters after max retries', async () => {
    vi.useFakeTimers()
    vi.mocked(deliverToDirectory).mockResolvedValueOnce({
      success: false,
      error: 'still offline',
      errorCode: 'OFFLINE',
      retryable: true,
      status: 503,
    })

    const id = insertMessage(db, {
      nonce: 'retry-nonce-1',
      sender: 'alpha@beam.directory',
      recipient: 'beta@beam.directory',
      intent: 'chat',
      payload: { text: 'hello' },
      maxRetries: 2,
    })
    scheduleRetry(db, id, 1, (Date.now() / 1000) - 1, 'offline')

    const timer = startRetryWorker({ db, directoryUrl: 'http://directory.test', intervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    stopRetryWorker(timer)

    expect(vi.mocked(deliverToDirectory)).toHaveBeenCalledWith(
      'http://directory.test',
      id,
      'retry-nonce-1',
      'alpha@beam.directory',
      'beta@beam.directory',
      'chat',
      { text: 'hello' },
    )
    expect(getMessage(db, id)?.status).toBe('dead_letter')
  })
})
