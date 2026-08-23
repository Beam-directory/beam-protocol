import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BeamIdentity } from 'beam-protocol-sdk'
import { loadBeamMcpConfig } from './config.js'

function env(): NodeJS.ProcessEnv {
  const identity = BeamIdentity.generate({ agentName: 'grok', orgName: 'acme' }).export()
  return {
    BEAM_ID: identity.beamId,
    BEAM_PUBLIC_KEY_BASE64: identity.publicKeyBase64,
    BEAM_PRIVATE_KEY_BASE64: identity.privateKeyBase64,
    BEAM_API_KEY: 'beam_live_test_key',
  }
}

test('loads a signed identity without exposing configuration defaults', () => {
  const config = loadBeamMcpConfig(env())
  assert.equal(config.beamId, 'grok@acme.beam.directory')
  assert.equal(config.directoryUrl, 'https://api.beam.directory')
  assert.deepEqual([...config.allowedIntents], ['conversation.message'])
  assert.equal(config.requireVerifiedTarget, true)
  assert.equal(config.minimumVerificationTier, 'verified')
  assert.equal(config.minimumTrustScore, 0.5)
})

test('loads Beam credentials from mounted secret files', () => {
  const values = env()
  const directory = mkdtempSync(join(tmpdir(), 'beam-mcp-config-'))
  try {
    for (const name of ['BEAM_PUBLIC_KEY_BASE64', 'BEAM_PRIVATE_KEY_BASE64', 'BEAM_API_KEY'] as const) {
      const file = join(directory, name.toLowerCase())
      writeFileSync(file, `${values[name]}\n`, { encoding: 'utf8', mode: 0o600 })
      values[`${name}_FILE`] = file
      delete values[name]
    }

    const config = loadBeamMcpConfig(values)
    assert.equal(config.beamId, 'grok@acme.beam.directory')
    assert.equal(config.apiKey, 'beam_live_test_key')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects insecure non-local directory URLs', () => {
  const values = env()
  values['BEAM_DIRECTORY_URL'] = 'http://api.example.com'
  assert.throws(() => loadBeamMcpConfig(values), /must use HTTPS/)
})

test('allows explicit localhost HTTP for development', () => {
  const values = env()
  values['BEAM_DIRECTORY_URL'] = 'http://127.0.0.1:3100/'
  assert.equal(loadBeamMcpConfig(values).directoryUrl, 'http://127.0.0.1:3100')
})

test('rejects mismatched key material', () => {
  const values = env()
  values['BEAM_PUBLIC_KEY_BASE64'] = BeamIdentity.generate({ agentName: 'other' }).publicKeyBase64
  assert.throws(() => loadBeamMcpConfig(values), /do not match/)
})

test('validates explicit target trust policy', () => {
  const values = env()
  values['BEAM_MCP_REQUIRE_VERIFIED_TARGET'] = 'false'
  values['BEAM_MCP_MIN_VERIFICATION_TIER'] = 'business'
  values['BEAM_MCP_MIN_TRUST_SCORE'] = '0.8'
  const config = loadBeamMcpConfig(values)
  assert.equal(config.requireVerifiedTarget, false)
  assert.equal(config.minimumVerificationTier, 'business')
  assert.equal(config.minimumTrustScore, 0.8)

  values['BEAM_MCP_MIN_TRUST_SCORE'] = '2'
  assert.throws(() => loadBeamMcpConfig(values), /between 0 and 1/)

  values['BEAM_MCP_MIN_TRUST_SCORE'] = '0.8'
  values['BEAM_MCP_MIN_VERIFICATION_TIER'] = 'kyc-ish'
  assert.throws(() => loadBeamMcpConfig(values), /basic, verified, business, or enterprise/)
})
