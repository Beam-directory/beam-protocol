import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicDirectoryForEvidence, createCompletionTemplate, isLoopback } from './external-dogfood-pack.mjs'

test('external dogfood pack identifies loopback directories', () => {
  assert.equal(isLoopback('http://localhost:43100'), true)
  assert.equal(isLoopback('http://127.0.0.1:43100'), true)
  assert.equal(isLoopback('https://api.beam.directory'), false)
})

test('external dogfood release evidence guard rejects localhost packs', () => {
  assert.throws(
    () => assertPublicDirectoryForEvidence('http://localhost:43100', true),
    /non-local Beam directory/u,
  )
})

test('external dogfood release evidence guard accepts public directories', () => {
  assert.doesNotThrow(() => assertPublicDirectoryForEvidence('https://api.beam.directory', true))
  assert.doesNotThrow(() => assertPublicDirectoryForEvidence('http://localhost:43100', false))
})

test('external dogfood completion template captures structured release evidence fields', () => {
  const completion = createCompletionTemplate({
    release: '1.7.0',
    generatedAt: '2026-06-09T00:00:00.000Z',
    directoryUrl: 'https://api.beam.directory',
    workspaceSlug: 'openclaw-external-dogfood',
    hostLabel: 'Partner MacBook',
    testerName: 'External Tester',
    testerEmail: 'tester@example.com',
    operatorName: 'External Operator',
    operatorEmail: 'operator@example.com',
    publicDirectory: true,
    packPath: '/tmp/pack.md',
    feedbackPath: '/tmp/feedback.md',
    enrollment: {
      id: 42,
      guidedEnrollmentUrl: 'https://dashboard.beam.directory/openclaw-fleet?enrollment=42',
      expiresAt: '2026-06-12T00:00:00.000Z',
    },
  })

  assert.equal(completion.template, true)
  assert.equal(completion.source.releaseEvidenceCandidate, true)
  assert.equal(completion.operator.external, true)
  assert.equal(completion.host.external, true)
  assert.equal(completion.host.bootstrapFlow, 'packaged')
  assert.equal(completion.host.installed, false)
  assert.equal(completion.supportHandoff.usedInRealDebug, false)
  assert.equal(completion.feedback.external, true)
})
