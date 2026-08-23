import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpPilotConfig, evaluateMcpPilotEvidence } from './mcp-pilot-evidence-check.mjs'

const digest = 'a'.repeat(64)
const now = new Date('2026-08-23T10:00:00.000Z')

function config(args = []) {
  return createMcpPilotConfig({ argv: ['node', 'mcp-pilot-evidence-check.mjs', ...args] })
}

function completeEvidence() {
  return {
    template: false,
    release: '1.7.0',
    testedAt: '2026-08-22T10:00:00.000Z',
    connector: {
      type: 'grok-custom-connector',
      mcpUrl: 'https://mcp.partner-corp.com/mcp',
      oauthIssuer: 'https://identity.partner-corp.com',
      externalNetwork: true,
      authorizationCodeFlow: true,
      pkceMethod: 'S256',
      grokConnectionVerified: true,
    },
    tenant: {
      dedicated: true,
      readOnly: true,
      sendEnabled: false,
      secretDelivery: 'mounted-files',
      minimumVerificationTier: 'business',
      imageDigest: `sha256:${digest}`,
    },
    observations: {
      healthStatus: 200,
      protectedResourceMetadataStatus: 200,
      unauthenticatedMcpStatus: 401,
      toolNames: ['beam_status', 'beam_prepare_handoff'],
      beamSendAdvertised: false,
      messageSent: false,
      targetLookupSucceeded: true,
      targetAssuranceTier: 'business',
      auditContentFree: true,
      tokenInAudit: false,
      secretInContainerEnvironment: false,
    },
    operator: {
      operatorRef: 'partner-operator-01',
      organization: 'Partner Corporation',
      external: true,
    },
    artifacts: [
      { kind: 'container-e2e', sha256: digest },
      { kind: 'container-sbom', sha256: digest },
      { kind: 'grok-diagnostics', sha256: digest },
      { kind: 'oauth-metadata', sha256: digest },
      { kind: 'redacted-audit', sha256: digest },
      { kind: 'vulnerability-scan', sha256: digest },
    ],
  }
}

test('MCP pilot evidence passes only for a fresh external read-only Grok connection', () => {
  const result = evaluateMcpPilotEvidence(completeEvidence(), config(), now)
  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.counts.tools, 2)
  assert.equal(result.counts.hashedArtifacts, 6)
})

test('MCP pilot evidence rejects templates, private networks, and send-enabled runs', () => {
  const evidence = completeEvidence()
  evidence.template = true
  evidence.connector.mcpUrl = 'https://10.0.0.1/mcp'
  evidence.tenant.sendEnabled = true
  evidence.observations.beamSendAdvertised = true
  evidence.observations.messageSent = true

  const result = evaluateMcpPilotEvidence(evidence, config(), now)
  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('template=false')), true)
  assert.equal(result.failures.some((failure) => failure.includes('public HTTPS')), true)
  assert.equal(result.failures.some((failure) => failure.includes('read-only')), true)
  assert.equal(result.failures.some((failure) => failure.includes('beam_send')), true)
})

test('MCP pilot evidence rejects stale evidence and secret-bearing fields', () => {
  const evidence = completeEvidence()
  evidence.testedAt = '2026-01-01T00:00:00.000Z'
  evidence.debug = { accessToken: 'must-never-be-recorded' }

  const result = evaluateMcpPilotEvidence(evidence, config(), now)
  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('no older than 30 days')), true)
  assert.equal(result.failures.some((failure) => failure.includes('debug.accessToken')), true)
  assert.equal(JSON.stringify(result).includes('must-never-be-recorded'), false)
})

test('MCP pilot evidence requires all hashed operator artifacts and exact tools', () => {
  const evidence = completeEvidence()
  evidence.observations.toolNames.push('beam_send')
  evidence.artifacts = evidence.artifacts.filter((artifact) => artifact.kind !== 'redacted-audit')

  const result = evaluateMcpPilotEvidence(evidence, config(), now)
  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('exactly')), true)
  assert.equal(result.failures.some((failure) => failure.includes('redacted-audit')), true)
})
