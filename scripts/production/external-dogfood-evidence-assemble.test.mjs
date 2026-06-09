import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleExternalDogfoodEvidenceFromCompletions } from './external-dogfood-evidence-assemble.mjs'

function completion(index, overrides = {}) {
  const operatorIndex = index % 2
  return {
    template: false,
    release: '1.7.0',
    generatedAt: '2026-06-09T00:00:00.000Z',
    source: {
      directoryUrl: 'https://api.beam.directory',
      workspaceSlug: 'openclaw-external-dogfood',
      publicDirectory: true,
      releaseEvidenceCandidate: true,
      packPath: `/tmp/host-${index}.md`,
    },
    operator: {
      name: `External Operator ${operatorIndex + 1}`,
      email: `operator${operatorIndex + 1}@example.com`,
      organization: `Partner ${operatorIndex + 1}`,
      external: true,
    },
    host: {
      label: `Partner Host ${index + 1}`,
      machine: index === 0 ? 'MacBook Pro' : 'Ubuntu VM',
      os: index === 0 ? 'macOS 15' : 'Ubuntu 24.04',
      operatorEmail: `operator${operatorIndex + 1}@example.com`,
      external: true,
      installed: true,
      bootstrapFlow: 'packaged',
      freshMachine: index === 0,
      noPreloadedRepoState: index === 0,
      heartbeatSeen: true,
      inventorySeen: true,
      installedAt: `2026-06-09T0${index}:00:00.000Z`,
    },
    supportHandoff: {
      type: index === 0 ? 'support-bundle' : 'fleet-analytics',
      hostLabel: `Partner Host ${index + 1}`,
      usedInRealDebug: true,
      summary: `Answered onboarding debug question for host ${index + 1}.`,
      exportedAt: `2026-06-09T0${index}:30:00.000Z`,
    },
    feedback: {
      tester: `External Tester ${index + 1}`,
      testerEmail: `tester${index + 1}@example.com`,
      hostLabel: `Partner Host ${index + 1}`,
      external: true,
      verdict: 'Worked without repo context.',
      productionBlocker: 'None for this pass.',
      solidSignal: 'Guided enrollment and heartbeat were clear.',
    },
    ...overrides,
  }
}

test('external dogfood evidence assembler passes completed production evidence', () => {
  const result = assembleExternalDogfoodEvidenceFromCompletions(
    Array.from({ length: 5 }, (_, index) => completion(index)),
    { release: '1.7.0', generatedAt: '2026-06-09T12:00:00.000Z' },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.evidence.operators.length, 2)
  assert.equal(result.evidence.hosts.length, 5)
  assert.equal(result.counts.externalPackagedHosts, 5)
})

test('external dogfood evidence assembler rejects templates, localhost, and TODO placeholders', () => {
  const bad = completion(0, {
    template: true,
    source: {
      directoryUrl: 'http://localhost:43100',
      publicDirectory: false,
      releaseEvidenceCandidate: false,
      packPath: '/tmp/local.md',
    },
    operator: {
      name: 'TODO operator',
      email: 'operator@example.com',
      organization: 'TODO org',
      external: true,
    },
    host: {
      ...completion(0).host,
      installed: false,
      machine: 'TODO machine',
    },
    supportHandoff: {
      ...completion(0).supportHandoff,
      usedInRealDebug: false,
      summary: 'TODO support summary',
    },
  })

  const result = assembleExternalDogfoodEvidenceFromCompletions([bad], {
    release: '1.7.0',
    generatedAt: '2026-06-09T12:00:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('template')), true)
  assert.equal(result.failures.some((failure) => failure.includes('non-local')), true)
  assert.equal(result.failures.some((failure) => failure.includes('TODO')), true)
  assert.equal(result.failures.some((failure) => failure.includes('host.installed')), true)
})
