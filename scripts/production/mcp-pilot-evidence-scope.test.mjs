import assert from 'node:assert/strict'
import test from 'node:test'
import { decideMcpPilotEvidence, isMcpPilotPath, isVersionOnlyChange, normalizeScope } from './mcp-pilot-evidence-scope.mjs'

const tagPush = { eventName: 'push', ref: 'refs/tags/v1.9.0', previousTag: 'v1.8.0' }
const workspaceNames = new Set(['beam-protocol-sdk', 'beam-protocol-cli', '@beam-protocol/mcp-server'])

function sdkPackageJson(version, extra = {}) {
  return JSON.stringify({ name: 'beam-protocol-sdk', version, files: ['dist'], ...extra }, null, 2)
}

function mcpPackageJson(version, sdkVersion, extra = {}) {
  return JSON.stringify({
    name: '@beam-protocol/mcp-server',
    version,
    dependencies: { 'beam-protocol-sdk': sdkVersion, zod: '^4.2.0', ...extra },
  }, null, 2)
}

function lockfile(version, { zod = '4.2.0' } = {}) {
  return JSON.stringify({
    name: 'beam-protocol',
    version,
    lockfileVersion: 3,
    packages: {
      '': { name: 'beam-protocol', version, workspaces: ['packages/*'] },
      'node_modules/beam-protocol-sdk': { resolved: 'packages/sdk-typescript', link: true },
      'node_modules/zod': { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz` },
      'packages/sdk-typescript': { name: 'beam-protocol-sdk', version },
      'packages/mcp-server': { name: '@beam-protocol/mcp-server', version: '0.1.0', dependencies: { 'beam-protocol-sdk': version, zod: '^4.2.0' } },
    },
  }, null, 2)
}

test('scope defaults to always for anything except the exact opt-in value', () => {
  assert.equal(normalizeScope(undefined), 'always')
  assert.equal(normalizeScope(''), 'always')
  assert.equal(normalizeScope('MCP-CHANGES'), 'always')
  assert.equal(normalizeScope('never'), 'always')
  assert.equal(normalizeScope(' mcp-changes '), 'mcp-changes')
})

test('default scope always requires evidence, even with no MCP changes', () => {
  const decision = decideMcpPilotEvidence({ scope: '', ...tagPush, changes: [{ file: 'packages/directory/src/server.ts' }] })
  assert.equal(decision.required, true)
  assert.equal(decision.scope, 'always')
})

test('opt-in scope still requires evidence for manual runs, branch pushes, and missing previous tags', () => {
  const changes = [{ file: 'docs/index.md' }]
  assert.equal(decideMcpPilotEvidence({ scope: 'mcp-changes', ...tagPush, eventName: 'workflow_dispatch', changes }).required, true)
  assert.equal(decideMcpPilotEvidence({ scope: 'mcp-changes', ...tagPush, ref: 'refs/heads/main', changes }).required, true)
  assert.equal(decideMcpPilotEvidence({ scope: 'mcp-changes', ...tagPush, previousTag: null, changes }).required, true)
})

test('opt-in scope skips evidence when only directory, dashboard, and docs changed', () => {
  const decision = decideMcpPilotEvidence({
    scope: 'mcp-changes',
    ...tagPush,
    changes: [
      { file: 'packages/directory/src/server.ts' },
      { file: 'packages/dashboard/src/App.tsx' },
      { file: 'docs/runbooks/RELEASING.md' },
      { file: 'CHANGELOG.md' },
      { file: 'package.json' },
    ],
  })
  assert.equal(decision.required, false)
  assert.deepEqual(decision.mcpChanges, [])
})

test('opt-in scope requires evidence when MCP server, SDK, pilot ops, or the gate itself changed', () => {
  for (const file of [
    'packages/mcp-server/src/tools.ts',
    'packages/sdk-typescript/src/client.ts',
    'ops/mcp-pilot/fly/mcp.fly.toml',
    'ops/mcp-tenant/compose.yaml',
    'scripts/production/mcp-pilot-evidence-check.mjs',
    'scripts/production/configure-keycloak-mcp-pilot.mjs',
    'scripts/e2e/mcp-container-remote.mjs',
    '.github/workflows/ci.yml',
  ]) {
    const decision = decideMcpPilotEvidence({ scope: 'mcp-changes', ...tagPush, changes: [{ file }] })
    assert.equal(decision.required, true, file)
    assert.deepEqual(decision.mcpChanges, [file])
  }
})

test('a pure release version bump does not count as an MCP change', () => {
  const changes = [
    { file: 'packages/sdk-typescript/package.json', before: sdkPackageJson('1.8.0'), after: sdkPackageJson('1.9.0') },
    { file: 'packages/mcp-server/package.json', before: mcpPackageJson('0.1.0', '1.8.0'), after: mcpPackageJson('0.1.0', '1.9.0') },
    { file: 'package-lock.json', before: lockfile('1.8.0'), after: lockfile('1.9.0') },
  ]
  const decision = decideMcpPilotEvidence({ scope: 'mcp-changes', ...tagPush, changes, workspaceNames })
  assert.equal(decision.required, false)
})

test('a dependency or files change next to the version bump counts as an MCP change', () => {
  assert.equal(isVersionOnlyChange('package-lock.json', lockfile('1.8.0'), lockfile('1.9.0', { zod: '4.3.0' }), workspaceNames), false)
  assert.equal(isVersionOnlyChange('packages/sdk-typescript/package.json', sdkPackageJson('1.8.0'), sdkPackageJson('1.9.0', { files: ['dist', 'src'] }), workspaceNames), false)
  assert.equal(isVersionOnlyChange('packages/mcp-server/package.json', mcpPackageJson('0.1.0', '1.8.0'), mcpPackageJson('0.1.0', '1.9.0', { zod: '^4.3.0' }), workspaceNames), false)
})

test('unreadable or added files are never treated as version-only', () => {
  assert.equal(isVersionOnlyChange('package-lock.json', null, lockfile('1.9.0'), workspaceNames), false)
  assert.equal(isVersionOnlyChange('package-lock.json', '{not json', lockfile('1.9.0'), workspaceNames), false)
  assert.equal(isVersionOnlyChange('packages/mcp-server/src/index.ts', 'a', 'b', workspaceNames), false)
})

test('path matching covers the pilot image inputs but not the directory', () => {
  assert.equal(isMcpPilotPath('LICENSE'), true)
  assert.equal(isMcpPilotPath('package-lock.json'), true)
  assert.equal(isMcpPilotPath('packages/directory/fly.toml'), false)
  assert.equal(isMcpPilotPath('packages/cli/src/index.ts'), false)
  assert.equal(isMcpPilotPath('scripts/production/workflow-production-guard-check.mjs'), false)
})
