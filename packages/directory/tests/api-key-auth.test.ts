import { generateKeyPairSync } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/email.js', () => ({
  sendAgentVerificationEmail: vi.fn(async () => true),
}))

import { createDatabase } from '../src/db.js'
import { createApp } from '../src/server.js'

function createIdentity() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  }
}

describe('directory api key auth', () => {
  let db: Database
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createDatabase(':memory:')
    app = createApp(db)
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
  })

  it('returns a bk_ api key and stores only its hash', async () => {
    const identity = createIdentity()
    const response = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'keyed@beam.directory',
        displayName: 'Keyed Agent',
        capabilities: ['conversation.message'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(String(body['apiKey'])).toMatch(/^bk_/)

    const row = db.prepare('SELECT api_key_hash FROM agents WHERE beam_id = ?').get('keyed@beam.directory') as { api_key_hash: string | null }
    expect(row.api_key_hash).toBeTruthy()
    expect(row.api_key_hash).not.toBe(body['apiKey'])
  })

  it('accepts x-api-key for agent deletion', async () => {
    const identity = createIdentity()
    const registerResponse = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'ephemeral@beam.directory',
        displayName: 'Ephemeral Agent',
        capabilities: ['conversation.message'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(registerResponse.status).toBe(201)
    const registered = await registerResponse.json() as Record<string, unknown>
    const apiKey = String(registered['apiKey'])

    const deleteResponse = await app.request('http://localhost/agents/ephemeral%40beam.directory', {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey },
    })

    expect(deleteResponse.status).toBe(204)
    expect(db.prepare('SELECT beam_id FROM agents WHERE beam_id = ?').get('ephemeral@beam.directory')).toBeUndefined()
  })
})
