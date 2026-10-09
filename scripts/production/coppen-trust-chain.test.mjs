import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  FORBIDDEN_ACTIONS,
  PINNED_DIRECTORY_KEY,
  TrustChainError,
  checkDirectoryUrl,
  generatePersonKeyFile,
  loadPersonKey,
  mandateTerms,
  parseConfig,
  personRef,
  rightsCovering,
  runRevoke,
  runTrustChain,
  verifyAssertionSignature,
} from './coppen-trust-chain.mjs'
import { ed25519Pair, seedCoppenFixture } from './coppen-trust-chain-local.mjs'
import { repoRoot } from './shared.mjs'

const configPath = path.join(repoRoot, 'scripts/production/coppen-trust-chain.config.json')
const shippedConfig = JSON.parse(readFileSync(configPath, 'utf8'))
const BASE = 'http://localhost'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'coppen-trust-chain-test-'))
}

async function loadDirectory() {
  const dist = path.join(repoRoot, 'packages/directory/dist')
  const [{ createApp }, db, adminAuth] = await Promise.all([
    import(pathToFileURL(path.join(dist, 'server.js')).href),
    import(pathToFileURL(path.join(dist, 'db.js')).href),
    import(pathToFileURL(path.join(dist, 'admin-auth.js')).href),
  ])
  return { createApp, ...db, createAdminSession: adminAuth.createAdminSession }
}

async function localDirectory(t) {
  const directory = await loadDirectory()
  const issuer = ed25519Pair()
  const previous = {
    privateKey: process.env.BEAM_DIRECTORY_SIGNING_PRIVATE_KEY,
    publicKey: process.env.BEAM_DIRECTORY_SIGNING_PUBLIC_KEY,
    jwt: process.env.JWT_SECRET,
  }
  process.env.BEAM_DIRECTORY_SIGNING_PRIVATE_KEY = issuer.privateKey
  process.env.BEAM_DIRECTORY_SIGNING_PUBLIC_KEY = issuer.publicKey
  process.env.JWT_SECRET = previous.jwt ?? 'coppen-trust-chain-test'
  const db = directory.createDatabase(':memory:')
  const app = directory.createApp(db)
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method ?? 'GET', url })
    return app.request(url, init)
  }
  const config = parseConfig(shippedConfig)
  const { apiKey } = await seedCoppenFixture({
    fetchImpl: (url, init) => app.request(url, init),
    base: BASE,
    agentNames: config.agents.map((agent) => agent.agentName),
    markVerified: async (name) => directory.markOrgVerified(db, name),
  })
  directory.assignDirectoryRole(db, { userId: 'operator@beam.directory', role: 'operator', directoryUrl: process.env.BEAM_DIRECTORY_URL ?? 'http://localhost:3100' })
  const adminToken = directory.createAdminSession(db, { email: 'operator@beam.directory', role: 'operator' }).token
  const dir = tempDir()
  const keyPath = path.join(dir, 'person-key.json')
  generatePersonKeyFile(keyPath)
  t.after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    for (const [name, value] of [
      ['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY', previous.privateKey],
      ['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY', previous.publicKey],
      ['JWT_SECRET', previous.jwt],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return {
    db,
    app,
    calls,
    config,
    keyPath,
    key: loadPersonKey(keyPath),
    keyFile: readFileSync(keyPath, 'utf8'),
    common: { config, key: loadPersonKey(keyPath), directoryUrl: BASE, orgApiKey: apiKey, adminToken, issuerPublicKey: issuer.publicKey, fetchImpl },
    secrets: { apiKey, adminToken, issuer },
  }
}

function capture() {
  const lines = []
  return { lines, log: (line) => lines.push(line), text: () => lines.join('\n') }
}

function writes(calls) {
  return calls.filter((call) => call.method !== 'GET')
}

test('the shipped config maps the owner decision to existing scope names and never allows ordering or paying', () => {
  const config = parseConfig(shippedConfig)
  assert.equal(config.org, 'coppen')
  assert.equal(config.validityDays, 90)
  assert.equal(config.person.displayName, 'Tobias Kub')
  assert.deepEqual(config.agents.map((agent) => agent.beamId), [
    'jarvis@coppen.beam.directory',
    'clara@coppen.beam.directory',
    'fischer@coppen.beam.directory',
  ])
  for (const agent of config.agents) {
    assert.deepEqual(agent.scopes, { actions: ['read', 'schedule.commit', 'file.send'] })
  }
  assert.deepEqual(FORBIDDEN_ACTIONS, ['order'])
})

test('config validation refuses order/payment scopes, unknown actions and too many agents', () => {
  const withOrder = { ...shippedConfig, defaultScopes: { actions: ['read', 'order'] } }
  assert.throws(() => parseConfig(withOrder), /may never order or pay/u)
  const withLimit = { ...shippedConfig, defaultScopes: { actions: ['read'], order: { maxAmount: '10.00', currency: 'EUR' } } }
  assert.throws(() => parseConfig(withLimit), /unknown scope field "order"/u)
  const unknown = { ...shippedConfig, defaultScopes: { actions: ['payment.submit'] } }
  assert.throws(() => parseConfig(unknown), /unknown action/u)
  const many = { ...shippedConfig, agents: Array.from({ length: 11 }, (_, index) => ({ beamId: `a${index}@coppen.beam.directory` })) }
  assert.throws(() => parseConfig(many), /1 to 10 agents/u)
  const noNote = { ...shippedConfig, kyc: { note: '' } }
  assert.throws(() => parseConfig(noNote), /kyc.note/u)
})

test('the pinned issuer key matches the SDK pin', () => {
  const sdk = readFileSync(path.join(repoRoot, 'packages/sdk-typescript/src/trust-assertion.ts'), 'utf8')
  const pinned = /DIRECTORY_SIGNING_PUBLIC_KEY =\s*'([^']+)'/u.exec(sdk)?.[1]
  assert.equal(PINNED_DIRECTORY_KEY, pinned)
})

test('only production or a local directory is accepted', () => {
  assert.equal(checkDirectoryUrl('https://api.beam.directory/').production, true)
  assert.equal(checkDirectoryUrl('http://127.0.0.1:4100').production, false)
  assert.throws(() => checkDirectoryUrl('https://evil.example'), TrustChainError)
})

test('mandates expire at 00:00 UTC, the configured number of days after the issue date', () => {
  const terms = mandateTerms(new Date('2026-10-09T23:04:00.000Z'), 90)
  assert.equal(terms.stamp, '20261009')
  assert.equal(terms.expiresAt, '2027-01-07T00:00:00.000Z')
})

test('rights are only widened, never narrowed', () => {
  const scopes = [{ actions: ['read', 'schedule.commit', 'file.send'] }]
  assert.deepEqual(rightsCovering(null, scopes), { actions: ['read', 'schedule.commit', 'file.send'] })
  const current = { actions: ['read', 'order'], order: { maxAmount: '50.00', currency: 'EUR' } }
  assert.deepEqual(rightsCovering(current, scopes), {
    actions: ['read', 'order', 'schedule.commit', 'file.send'],
    order: { maxAmount: '50.00', currency: 'EUR' },
  })
})

test('keygen writes a 0600 key file outside the repository and never overwrites', () => {
  const dir = tempDir()
  try {
    const keyPath = path.join(dir, 'key.json')
    const created = generatePersonKeyFile(keyPath)
    assert.equal(statSync(keyPath).mode & 0o777, 0o600)
    assert.equal(loadPersonKey(keyPath).publicKey, created.publicKey)
    assert.throws(() => generatePersonKeyFile(keyPath), /already exists/u)
    assert.throws(() => generatePersonKeyFile(path.join(repoRoot, 'person-key.json')), /inside the repository/u)
    chmodSync(keyPath, 0o644)
    assert.throws(() => loadPersonKey(keyPath), /readable by others/u)
    chmodSync(keyPath, 0o600)
    const record = JSON.parse(readFileSync(keyPath, 'utf8'))
    writeFileSync(keyPath, JSON.stringify({ ...record, publicKey: ed25519Pair().publicKey }), { mode: 0o600 })
    assert.throws(() => loadPersonKey(keyPath), /does not match/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dry run sends no write call and prints no secret', async (t) => {
  const local = await localDirectory(t)
  const out = capture()
  const result = await runTrustChain({ ...local.common, log: out.log })
  assert.equal(result.apply, false)
  assert.deepEqual(writes(local.calls), [])
  assert.equal(result.results.every((entry) => entry.person === null && entry.mandate === null), true)
  const text = out.text()
  assert.match(text, /DRY RUN finished\. No write call was sent\./u)
  assert.match(text, /WOULD POST http:\/\/localhost\/agents\/jarvis%40coppen\.beam\.directory\/mandates/u)
  const privateKey = JSON.parse(local.keyFile).privateKey
  assert.equal(text.includes(privateKey), false)
  assert.equal(text.includes(local.secrets.apiKey), false)
  assert.equal(text.includes(local.secrets.adminToken), false)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS count FROM persons').get()).count, 0)
  assert.equal((local.db.prepare('SELECT COUNT(*) AS count FROM mandates').get()).count, 0)
})

test('apply wires person and mandate for every agent, the assertion verifies, and a second run writes nothing', async (t) => {
  const local = await localDirectory(t)
  const out = capture()
  const applied = await runTrustChain({ ...local.common, apply: true, log: out.log })
  assert.equal(applied.ok, true, out.text())
  const ref = personRef(applied.personId)
  for (const entry of applied.results) {
    assert.equal(entry.signatureValid, true)
    assert.equal(entry.person.ref, ref)
    assert.equal(entry.person.kycStatus, 'verified')
    assert.deepEqual(entry.mandate.scopes, { actions: ['read', 'schedule.commit', 'file.send'] })
    assert.equal(entry.mandate.scopes.actions.includes('order'), false)
  }
  for (const agent of local.config.agents) {
    const response = await local.app.request(`${BASE}/agents/${encodeURIComponent(agent.beamId)}/trust-assertion`, {
      headers: { 'x-api-key': local.secrets.apiKey },
    })
    const assertion = await response.json()
    assert.equal(verifyAssertionSignature(assertion, local.secrets.issuer.publicKey), true)
    assert.equal(verifyAssertionSignature({ ...assertion, mandate: null }, local.secrets.issuer.publicKey), false)
  }
  const signatures = local.db.prepare('SELECT signature FROM mandates').all().map((row) => row.signature)
  assert.equal(signatures.length, 3)
  for (const signature of signatures) assert.equal(out.text().includes(signature), false)
  assert.equal(out.text().includes(JSON.parse(local.keyFile).privateKey), false)

  local.calls.length = 0
  const again = await runTrustChain({ ...local.common, apply: true, log: () => {} })
  assert.equal(again.ok, true)
  assert.deepEqual(writes(local.calls), [])
})

test('a revoked mandate is not re-created by replay, and --issue-tag re-issues it', async (t) => {
  const local = await localDirectory(t)
  const applied = await runTrustChain({ ...local.common, apply: true, log: () => {} })
  const jarvis = local.config.agents[0].beamId
  const jti = applied.results[0].mandate.jti

  local.calls.length = 0
  await runRevoke({ ...local.common, beamId: jarvis, jti, log: () => {} })
  assert.deepEqual(writes(local.calls), [])

  const revoked = await runRevoke({ ...local.common, beamId: jarvis, jti, apply: true, log: () => {} })
  assert.equal(revoked.ok, true)

  const out = capture()
  const replay = await runTrustChain({ ...local.common, apply: true, log: out.log })
  assert.equal(replay.ok, false)
  assert.match(out.text(), /MANDATE_REPLAY/u)
  assert.equal(replay.results[0].mandate, null)

  const reissued = await runTrustChain({ ...local.common, apply: true, issueTag: 'r2', log: () => {} })
  assert.equal(reissued.ok, true)
  assert.equal(reissued.results[0].mandate.jti, `${jti}-r2`)
})

test('apply stops before any write when the operator session is missing or the person key differs', async (t) => {
  const local = await localDirectory(t)
  await assert.rejects(
    runTrustChain({ ...local.common, adminToken: '', apply: true, log: () => {} }),
    /operator session for the KYC review/u,
  )
  assert.deepEqual(writes(local.calls), [])

  await runTrustChain({ ...local.common, apply: true, log: () => {} })
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const otherKeyPath = path.join(dir, 'other.json')
  generatePersonKeyFile(otherKeyPath)
  local.calls.length = 0
  await assert.rejects(
    runTrustChain({ ...local.common, key: loadPersonKey(otherKeyPath), apply: true, log: () => {} }),
    /already has a different public key/u,
  )
  assert.deepEqual(writes(local.calls), [])
})
