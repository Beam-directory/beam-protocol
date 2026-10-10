import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './shared.mjs'
import { main, parseInput, planBatch } from './agent-config-batch.mjs'

const dist = (file) => pathToFileURL(path.join(repoRoot, 'packages/directory/dist', file)).href
const { createDatabase, getAgent, registerAgent } = await import(dist('db.js'))
const { createApp } = await import(dist('server.js'))

function ed25519() {
  const keys = generateKeyPairSync('ed25519')
  return {
    privateDer: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    privatePem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

function x25519() {
  return generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function setup(count = 2) {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'agent-config-batch-test'
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-config-batch-'))
  const agents = []
  for (let index = 0; index < count; index += 1) {
    const beamId = `agent${index}@beam.directory`
    const current = ed25519()
    const next = ed25519()
    registerAgent(db, { beamId, displayName: `Agent ${index}`, capabilities: ['conversation.message'], publicKey: current.publicKey, personal: true })
    writeFileSync(path.join(dir, `${index}.key`), index % 2 === 0 ? current.privateDer : current.privatePem, { mode: 0o600 })
    writeFileSync(path.join(dir, `${index}.next.key`), next.privateDer, { mode: 0o600 })
    agents.push({ beamId, current, next, dhPublicKey: x25519() })
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ method: init.method ?? 'GET', url: String(url) })
    return app.request(String(url), init)
  }
  return { db, dir, agents, requests, fetchImpl, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function writeInput(dir, agents) {
  const file = path.join(dir, 'agents.json')
  writeFileSync(file, JSON.stringify(agents.map((agent, index) => ({
    beamId: agent.beamId,
    keyPath: `${index}.key`,
    newKeyPath: `${index}.next.key`,
    httpEndpoint: `https://agents.example.com/${index}`,
    dhPublicKey: agent.dhPublicKey,
  }))))
  return file
}

function capture() {
  let text = ''
  return { stdout: { write: (chunk) => { text += chunk } }, text: () => text }
}

test('CSV and JSON inputs produce the same rows', () => {
  const csv = parseInput('beamId,keyPath,httpEndpoint\n# comment\na@beam.directory,a.key,https://x.example\n', 'csv')
  const json = parseInput(JSON.stringify({ agents: [{ beamId: 'a@beam.directory', keyPath: 'a.key', httpEndpoint: 'https://x.example' }] }), 'json')
  assert.deepEqual(csv, json)
  assert.throws(() => parseInput('beamId,privateKey\n', 'csv'), /Unknown CSV columns/)
})

test('dry run plans PATCH and rotation, sends only reads and never prints private keys', async () => {
  const ctx = setup(2)
  try {
    const input = writeInput(ctx.dir, ctx.agents)
    const out = capture()
    const code = await main(['--input', input, '--directory-url', 'http://directory.test', '--expect', '2', '--json', path.join(ctx.dir, 'report.json')], { fetchImpl: ctx.fetchImpl, stdout: out.stdout })
    assert.equal(code, 0)
    assert.deepEqual([...new Set(ctx.requests.map((request) => request.method))], ['GET'])
    const text = out.text()
    assert.match(text, /DRY RUN/)
    assert.match(text, /PATCH http:\/\/directory\.test\/agents\/agent0%40beam\.directory\/config/)
    assert.match(text, /POST http:\/\/directory\.test\/agents\/agent1%40beam\.directory\/keys\/rotate/)
    assert.match(text, /total 2 \| planned 2/)
    for (const agent of ctx.agents) {
      assert.equal(getAgent(ctx.db, agent.beamId).public_key, agent.current.publicKey)
      assert.equal(text.includes(agent.next.publicKey), true)
      for (const secret of [agent.current.privateDer, agent.next.privateDer, agent.current.privatePem.split('\n')[1]]) {
        assert.equal(text.includes(secret), false)
      }
    }
    assert.doesNotMatch(text, /signature"?:/)
  } finally {
    ctx.cleanup()
  }
})

test('--apply sends a signed PATCH and a signed rotation for every agent', async () => {
  const ctx = setup(2)
  try {
    const input = writeInput(ctx.dir, ctx.agents)
    const out = capture()
    const code = await main(['--input', input, '--directory-url', 'http://directory.test', '--apply'], { fetchImpl: ctx.fetchImpl, stdout: out.stdout })
    assert.equal(code, 0, out.text())
    assert.match(out.text(), /applied 2/)
    ctx.agents.forEach((agent, index) => {
      const row = getAgent(ctx.db, agent.beamId)
      assert.equal(row.public_key, agent.next.publicKey)
      assert.equal(row.dh_public_key, agent.dhPublicKey)
      assert.equal(row.http_endpoint, `https://agents.example.com/${index}`)
    })
  } finally {
    ctx.cleanup()
  }
})

test('--apply refuses to send anything when one entry is invalid', async () => {
  const ctx = setup(2)
  try {
    const input = path.join(ctx.dir, 'agents.json')
    writeFileSync(input, JSON.stringify([
      { beamId: ctx.agents[0].beamId, keyPath: '0.key', newKeyPath: '0.next.key' },
      { beamId: ctx.agents[1].beamId, keyPath: '0.key', newKeyPath: '1.next.key' },
    ]))
    const out = capture()
    await assert.rejects(
      main(['--input', input, '--directory-url', 'http://directory.test', '--apply'], { fetchImpl: ctx.fetchImpl, stdout: out.stdout }),
      /invalid entries/,
    )
    assert.deepEqual([...new Set(ctx.requests.map((request) => request.method))], ['GET'])
    assert.equal(getAgent(ctx.db, ctx.agents[0].beamId).public_key, ctx.agents[0].current.publicKey)
  } finally {
    ctx.cleanup()
  }
})

test('plan flags bad keys, bad fields and an --expect mismatch', async () => {
  const ctx = setup(1)
  try {
    writeFileSync(path.join(ctx.dir, 'x25519.key'), generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'))
    const { plan } = await planBatch([
      { beamId: 'Not A Beam Id', keyPath: 'missing.key' },
      { beamId: ctx.agents[0].beamId, keyPath: 'x25519.key', httpEndpoint: 'http://plain.example', dhPublicKey: 'nope' },
      { beamId: ctx.agents[0].beamId, keyPath: '0.key', newKeyPath: '0.key' },
    ], { baseDir: ctx.dir })
    assert.deepEqual(plan.map((entry) => entry.status), ['invalid', 'invalid', 'invalid'])
    assert.ok(plan[0].errors.includes('beamId is not a valid Beam ID'))
    assert.ok(plan[1].errors.some((error) => /not an Ed25519 key/.test(error)))
    assert.ok(plan[1].errors.includes('httpEndpoint must use https'))
    assert.ok(plan[2].errors.includes('beamId appears more than once'))
    assert.ok(plan[2].errors.includes('newKeyPath holds the current key'))

    const input = writeInput(ctx.dir, ctx.agents)
    await assert.rejects(main(['--input', input, '--expect', '16'], { fetchImpl: ctx.fetchImpl, stdout: capture().stdout }), /--expect 16/)
  } finally {
    ctx.cleanup()
  }
})

test('a key file that no longer matches the directory is invalid', async () => {
  const ctx = setup(1)
  try {
    writeFileSync(path.join(ctx.dir, 'stale.key'), ed25519().privateDer)
    const { plan } = await planBatch([
      { beamId: ctx.agents[0].beamId, keyPath: 'stale.key', newKeyPath: '0.next.key' },
    ], { baseDir: ctx.dir, directoryUrl: 'http://directory.test', fetchImpl: ctx.fetchImpl })
    assert.equal(plan[0].status, 'invalid')
    assert.ok(plan[0].errors.includes('keyPath does not match the active key in the directory'))
  } finally {
    ctx.cleanup()
  }
})
