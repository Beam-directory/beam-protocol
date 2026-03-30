import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server.js'
import { createDatabase } from './db.js'

test('cors allows production public-site and loopback dashboard origins', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const beamOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'https://beam.directory' },
    }))
    assert.equal(beamOriginResponse.headers.get('access-control-allow-origin'), 'https://beam.directory')

    const localOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'http://localhost:43173' },
    }))
    assert.equal(localOriginResponse.headers.get('access-control-allow-origin'), 'http://localhost:43173')

    const unknownOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'https://evil.example' },
    }))
    assert.equal(unknownOriginResponse.headers.get('access-control-allow-origin'), null)
  } finally {
    db.close()
  }
})

test('waitlist signups are idempotent by email and preserve the original created timestamp', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const firstResponse = await app.request(new Request('http://localhost/waitlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://beam.directory',
      },
      body: JSON.stringify({
        email: 'ops@example.com',
        source: 'hosted-beta',
        company: 'Acme',
        agentCount: 8,
      }),
    }))

    assert.equal(firstResponse.status, 201)
    assert.equal(firstResponse.headers.get('access-control-allow-origin'), 'https://beam.directory')
    const first = await firstResponse.json() as {
      ok: boolean
      status: string
      createdAt: string
      company: string
      agentCount: number
    }
    assert.equal(first.ok, true)
    assert.equal(first.status, 'registered')
    assert.equal(first.company, 'Acme')
    assert.equal(first.agentCount, 8)

    const secondResponse = await app.request(new Request('http://localhost/waitlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://beam.directory',
      },
      body: JSON.stringify({
        email: 'ops@example.com',
        source: 'hosted-beta-follow-up',
        company: 'Acme Renewed',
        agentCount: 14,
      }),
    }))

    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as {
      ok: boolean
      status: string
      createdAt: string
      company: string
      agentCount: number
      source: string
    }
    assert.equal(second.ok, true)
    assert.equal(second.status, 'already_registered')
    assert.equal(second.company, 'Acme Renewed')
    assert.equal(second.agentCount, 14)
    assert.equal(second.source, 'hosted-beta-follow-up')
    assert.equal(second.createdAt, first.createdAt)

    const row = db.prepare(`
      SELECT COUNT(*) AS count, company, agent_count, source, created_at
      FROM waitlist
      WHERE email = ?
    `).get('ops@example.com') as {
      count: number
      company: string
      agent_count: number
      source: string
      created_at: string
    }

    assert.equal(row.count, 1)
    assert.equal(row.company, 'Acme Renewed')
    assert.equal(row.agent_count, 14)
    assert.equal(row.source, 'hosted-beta-follow-up')
    assert.equal(row.created_at, first.createdAt)
  } finally {
    db.close()
  }
})
