import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './shared.mjs'
import { applySuspension, main, openReadOnly, reviewDatabase } from './squatting-review.mjs'

const dist = (file) => pathToFileURL(path.join(repoRoot, 'packages/directory/dist', file)).href
const { assignDirectoryRole, createDatabase, createOrg, markOrgVerified, registerAgent } = await import(dist('db.js'))
const { getLocalDirectoryUrl } = await import(dist('federation.js'))
const { createApp } = await import(dist('server.js'))
const { createAdminSession } = await import(dist('admin-auth.js'))

function publicKey() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function seedSquattingFixture(db) {
  const agent = (beamId, org, displayName = beamId.split('@')[0]) => registerAgent(db, {
    beamId,
    displayName,
    capabilities: ['conversation.message'],
    publicKey: publicKey(),
    org,
    personal: org === null,
  })
  agent('booking@lufthansa.beam.directory', 'lufthansa', 'Lufthansa Booking')
  createOrg(db, { name: 'siemens', displayName: 'Siemens Agents', domain: 'siemens-agents.net', apiKeyHash: 'x'.repeat(64), verificationToken: 't1' })
  markOrgVerified(db, 'siemens', 'dns')
  agent('sales@siemens.beam.directory', 'siemens')
  agent('support@siemens.beam.directory', 'siemens')
  createOrg(db, { name: 'bmw', displayName: 'BMW', domain: 'bmw.de', apiKeyHash: 'y'.repeat(64), verificationToken: 't2' })
  markOrgVerified(db, 'bmw', 'dns')
  agent('dealer@bmw.beam.directory', 'bmw')
  agent('dhl-tracking@beam.directory', null)
  agent('sdb@beam.directory', null)
  agent('bahnhof-cafe@beam.directory', null)
  agent('alice@beam.directory', null)
}

function setup() {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'squatting-review-test'
  const dir = mkdtempSync(path.join(tmpdir(), 'squatting-review-'))
  const dbPath = path.join(dir, 'directory.sqlite')
  const db = createDatabase(dbPath)
  seedSquattingFixture(db)
  const app = createApp(db)
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ method: init.method ?? 'GET', url: String(url) })
    return app.request(String(url), init)
  }
  let text = ''
  const stdout = { write: (chunk) => { text += chunk } }
  return { dir, dbPath, db, requests, fetchImpl, stdout, text: () => text, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('review lists brand agents with evidence and skips lookalikes', async () => {
  const ctx = setup()
  try {
    const db = await openReadOnly(ctx.dbPath)
    const review = reviewDatabase(db)
    db.close()
    const byId = Object.fromEntries(review.candidates.map((candidate) => [candidate.beamId, candidate]))
    assert.deepEqual(Object.keys(byId).sort(), [
      'booking@lufthansa.beam.directory',
      'dealer@bmw.beam.directory',
      'dhl-tracking@beam.directory',
      'sales@siemens.beam.directory',
      'support@siemens.beam.directory',
    ])
    assert.equal(byId['booking@lufthansa.beam.directory'].assessment.finding, 'no-org-record')
    assert.equal(byId['booking@lufthansa.beam.directory'].assessment.risk, 'high')
    assert.equal(byId['booking@lufthansa.beam.directory'].action.kind, 'manual')
    assert.equal(byId['sales@siemens.beam.directory'].assessment.finding, 'org-domain-not-brand')
    assert.equal(byId['sales@siemens.beam.directory'].action.kind, 'suspend-org')
    assert.deepEqual(byId['sales@siemens.beam.directory'].action.affectedAgents, ['sales@siemens.beam.directory', 'support@siemens.beam.directory'])
    assert.equal(byId['dealer@bmw.beam.directory'].assessment.risk, 'none')
    assert.equal(byId['dhl-tracking@beam.directory'].assessment.finding, 'personal-namespace')
    assert.ok(byId['booking@lufthansa.beam.directory'].evidence.agentCreatedAt)
  } finally {
    ctx.cleanup()
  }
})

test('dry run sends nothing, leaves the database untouched and never offers a delete', async () => {
  const ctx = setup()
  try {
    ctx.db.pragma('wal_checkpoint(TRUNCATE)')
    const before = createHash('sha256').update(readFileSync(ctx.dbPath)).digest('hex')
    const code = await main(['--db', ctx.dbPath, '--focus', 'booking@lufthansa.beam.directory', '--directory-url', 'https://directory.example'], { fetchImpl: ctx.fetchImpl, stdout: ctx.stdout, env: {} })
    assert.equal(code, 0)
    assert.equal(ctx.requests.length, 0)
    assert.equal(createHash('sha256').update(readFileSync(ctx.dbPath)).digest('hex'), before)
    const text = ctx.text()
    assert.match(text, /## booking@lufthansa\.beam\.directory \(focus\)/)
    assert.match(text, /curl -sS -X POST 'https:\/\/directory\.example\/admin\/orgs\/siemens\/suspension'/)
    assert.match(text, /--confirm-org siemens/)
    assert.match(text, /Not offered: deleting the agent/)
    assert.match(text, /Dry run\. No request was sent\./)
    assert.doesNotMatch(text, /-X DELETE/)
  } finally {
    ctx.cleanup()
  }
})

test('--apply needs --confirm, a suspendable candidate, --confirm-org and a note', async () => {
  const ctx = setup()
  try {
    const run = (args, env = { BEAM_ADMIN_TOKEN: 'token' }) => main(['--db', ctx.dbPath, '--directory-url', 'http://directory.test', ...args], { fetchImpl: ctx.fetchImpl, stdout: ctx.stdout, env })
    await assert.rejects(run(['--apply']), /--apply needs --confirm/)
    await assert.rejects(run(['--apply', '--confirm', 'booking@lufthansa.beam.directory', '--note', 'squat']), /no suspension this script can run \(manual\)/)
    await assert.rejects(run(['--apply', '--confirm', 'dealer@bmw.beam.directory', '--note', 'squat']), /\(none\)/)
    await assert.rejects(run(['--apply', '--confirm', 'sales@siemens.beam.directory', '--note', 'squat']), /--confirm-org siemens/)
    await assert.rejects(run(['--apply', '--confirm', 'sales@siemens.beam.directory', '--confirm-org', 'siemens']), /--note is required/)
    await assert.rejects(run(['--apply', '--confirm', 'sales@siemens.beam.directory', '--confirm-org', 'siemens', '--note', 'squat'], {}), /BEAM_ADMIN_TOKEN/)
    assert.equal(ctx.requests.length, 0)
  } finally {
    ctx.cleanup()
  }
})

test('--apply with full confirmation suspends the org through the admin route and nothing else', async () => {
  const ctx = setup()
  try {
    assignDirectoryRole(ctx.db, { userId: 'ops@beam.directory', role: 'operator', directoryUrl: getLocalDirectoryUrl() })
    const { token } = createAdminSession(ctx.db, { email: 'ops@beam.directory', role: 'operator' })
    const code = await main([
      '--db', ctx.dbPath,
      '--directory-url', 'http://directory.test',
      '--apply', '--confirm', 'sales@siemens.beam.directory', '--confirm-org', 'siemens',
      '--note', 'Brand squatting review',
    ], { fetchImpl: ctx.fetchImpl, stdout: ctx.stdout, env: { BEAM_ADMIN_TOKEN: token } })
    assert.equal(code, 0)
    assert.deepEqual(ctx.requests, [{ method: 'POST', url: 'http://directory.test/admin/orgs/siemens/suspension' }])
    assert.ok(ctx.db.prepare('SELECT suspended_at FROM orgs WHERE name = ?').get('siemens').suspended_at)
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM agents').get().count, 8)
    assert.equal(token.length > 0 && ctx.text().includes(token), false)
  } finally {
    ctx.cleanup()
  }
})

test('the script has no delete code path', () => {
  const source = readFileSync(new URL('./squatting-review.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /method:\s*['"]DELETE['"]/)
  assert.doesNotMatch(source, /DELETE FROM/i)
  assert.equal(typeof applySuspension, 'function')
})
