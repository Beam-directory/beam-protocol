import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/delivery.js', () => ({
  deliverToDirectory: vi.fn(async () => ({ success: true, error: '' })),
}))

import { cleanTestMessages, getMessage, initDatabase, insertMessage, markAcked, markDelivered, markFailed } from '../src/db.js'
import { createBusRouter } from '../src/router.js'

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
    expect(body['status']).toBe('delivered')
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

    markDelivered(db, deliveredId)
    markDelivered(db, ackedId)
    markAcked(db, ackedId, { ok: true })
    markFailed(db, failedId, 'boom')

    expect(getMessage(db, pendingId)?.status).toBe('pending')

    const response = await app.request('http://localhost/v1/beam/stats')
    expect(response.status).toBe(200)

    const body = await response.json() as Record<string, unknown>
    expect(body['total']).toBe(4)
    expect(body['pending']).toBe(1)
    expect(body['delivered']).toBe(1)
    expect(body['acked']).toBe(1)
    expect(body['failed']).toBe(1)
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
    expect(getMessage(db, keptId)?.status).toBe('pending')
  })
})
