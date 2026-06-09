import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createExternalDogfoodConfig,
  evaluateExternalDogfoodEvidence,
} from './external-dogfood-evidence-check.mjs'

function config(args = []) {
  return createExternalDogfoodConfig({
    argv: ['node', 'external-dogfood-evidence-check.mjs', ...args],
  })
}

function completeEvidence() {
  return {
    release: '1.7.0',
    operators: [
      { name: 'External Operator 1', email: 'operator1@example.com', external: true },
      { name: 'External Operator 2', email: 'operator2@example.com', external: true },
    ],
    hosts: Array.from({ length: 5 }, (_, index) => ({
      label: `Partner Host ${index + 1}`,
      machine: index === 0 ? 'MacBook Pro' : 'Ubuntu VM',
      os: index === 0 ? 'macOS 15' : 'Ubuntu 24.04',
      external: true,
      installed: true,
      bootstrapFlow: 'packaged',
      freshMachine: index === 0,
      noPreloadedRepoState: index === 0,
    })),
    supportHandoffs: [
      {
        type: 'support-bundle',
        hostLabel: 'Partner Host 1',
        usedInRealDebug: true,
        summary: 'The bundle explained a route health issue during onboarding.',
      },
    ],
    feedback: [
      {
        tester: 'External Tester 1',
        hostLabel: 'Partner Host 1',
        external: true,
        verdict: 'Worked without repo context.',
        solidSignal: 'The guided enrollment link made sense.',
      },
      {
        tester: 'External Tester 2',
        hostLabel: 'Partner Host 2',
        external: true,
        verdict: 'Support export was actionable.',
        solidSignal: 'Heartbeat and inventory were easy to verify.',
      },
    ],
  }
}

test('external dogfood evidence check passes the production evidence threshold', () => {
  const evaluation = evaluateExternalDogfoodEvidence(completeEvidence(), config())

  assert.equal(evaluation.ok, true)
  assert.deepEqual(evaluation.failures, [])
  assert.equal(evaluation.counts.externalOperators, 2)
  assert.equal(evaluation.counts.externalPackagedHosts, 5)
  assert.equal(evaluation.counts.freshMachineHosts, 1)
  assert.equal(evaluation.counts.realSupportHandoffs, 1)
  assert.equal(evaluation.counts.externalFeedback, 2)
})

test('external dogfood evidence check names missing production evidence', () => {
  const evaluation = evaluateExternalDogfoodEvidence({
    release: '1.7.0',
    operators: [{ name: 'Local Maintainer', external: false }],
    hosts: [
      {
        label: 'Local Host',
        machine: 'MacBook',
        os: 'macOS',
        external: false,
        installed: true,
        bootstrapFlow: 'packaged',
      },
    ],
    supportHandoffs: [],
    feedback: [],
  }, config())

  assert.equal(evaluation.ok, false)
  assert.equal(evaluation.failures.some((failure) => failure.includes('external operators')), true)
  assert.equal(evaluation.failures.some((failure) => failure.includes('external packaged-bootstrap hosts')), true)
  assert.equal(evaluation.failures.some((failure) => failure.includes('fresh-machine onboarding')), true)
  assert.equal(evaluation.failures.some((failure) => failure.includes('support-bundle or fleet-analytics')), true)
  assert.equal(evaluation.failures.some((failure) => failure.includes('written external feedback')), true)
})

test('external dogfood evidence check rejects template files explicitly', () => {
  const evidence = completeEvidence()
  evidence.template = true

  const evaluation = evaluateExternalDogfoodEvidence(evidence, config())

  assert.equal(evaluation.ok, false)
  assert.equal(evaluation.failures.some((failure) => failure.includes('marked as a template')), true)
})
