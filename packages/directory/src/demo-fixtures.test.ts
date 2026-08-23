import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentApiKey } from './api-key.js'
import { seedDemoFixturesFromEnvironment } from './demo-fixtures.js'
import { createDatabase, getAgent, getOrg } from './db.js'

function buildFixture(beamId: string) {
  const { publicKey } = generateKeyPairSync('ed25519')
  return {
    beamId,
    apiKey: createAgentApiKey(beamId),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

test('demo fixtures require an explicit loopback-only opt in and seed idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'beam-demo-fixtures-'))
  const fixturePath = join(root, 'identities.json')
  writeFileSync(fixturePath, JSON.stringify({
    procurement: buildFixture('procurement@acme.beam.directory'),
    partnerDesk: buildFixture('partner-desk@northwind.beam.directory'),
    warehouse: buildFixture('warehouse@northwind.beam.directory'),
    finance: buildFixture('finance@acme.beam.directory'),
  }))

  const db = createDatabase(':memory:')
  const previous = {
    enabled: process.env['BEAM_ENABLE_DEMO_FIXTURES'],
    publicBaseUrl: process.env['PUBLIC_BASE_URL'],
    fixturePath: process.env['BEAM_DEMO_FIXTURE_PATH'],
  }

  try {
    delete process.env['BEAM_ENABLE_DEMO_FIXTURES']
    assert.equal(seedDemoFixturesFromEnvironment(db), false)

    process.env['BEAM_ENABLE_DEMO_FIXTURES'] = 'true'
    process.env['PUBLIC_BASE_URL'] = 'https://directory.example.com'
    process.env['BEAM_DEMO_FIXTURE_PATH'] = fixturePath
    assert.throws(() => seedDemoFixturesFromEnvironment(db), /loopback/u)

    process.env['PUBLIC_BASE_URL'] = 'http://localhost:43100'
    assert.equal(seedDemoFixturesFromEnvironment(db), true)
    db.prepare("UPDATE agents SET api_key_hash = 'legacy-demo-key' WHERE beam_id = ?").run('procurement@acme.beam.directory')
    assert.equal(seedDemoFixturesFromEnvironment(db), true)
    assert.equal(getOrg(db, 'acme')?.verified, 1)
    assert.equal(getOrg(db, 'northwind')?.verified, 1)
    assert.equal(getAgent(db, 'procurement@acme.beam.directory')?.verified, 1)
    assert.notEqual(getAgent(db, 'procurement@acme.beam.directory')?.api_key_hash, 'legacy-demo-key')
    assert.equal(getAgent(db, 'warehouse@northwind.beam.directory')?.visibility, 'public')
  } finally {
    if (previous.enabled === undefined) delete process.env['BEAM_ENABLE_DEMO_FIXTURES']
    else process.env['BEAM_ENABLE_DEMO_FIXTURES'] = previous.enabled
    if (previous.publicBaseUrl === undefined) delete process.env['PUBLIC_BASE_URL']
    else process.env['PUBLIC_BASE_URL'] = previous.publicBaseUrl
    if (previous.fixturePath === undefined) delete process.env['BEAM_DEMO_FIXTURE_PATH']
    else process.env['BEAM_DEMO_FIXTURE_PATH'] = previous.fixturePath
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
