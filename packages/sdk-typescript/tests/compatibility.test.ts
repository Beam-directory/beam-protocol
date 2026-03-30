import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BeamIdentity, canonicalizeFrame, signFrame, validateIntentFrame, validateResultFrame } from '../src/index.js'

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../spec/fixtures/compatibility')
const archivedFixtureDir = path.join(fixtureDir, 'releases')

function loadFixture<T extends Record<string, unknown>>(name: string): T {
  const raw = readFileSync(path.join(fixtureDir, name), 'utf8')
  return JSON.parse(raw) as T
}

function hydrateTimestamp<T extends Record<string, unknown>>(frame: T): T {
  const copy = JSON.parse(JSON.stringify(frame)) as T
  if (copy['timestamp'] === '__NOW__') {
    copy['timestamp'] = new Date().toISOString() as T[keyof T]
  }
  return copy
}

function loadArchivedFixture<T extends Record<string, unknown>>(release: string, name: string): T {
  const raw = readFileSync(path.join(archivedFixtureDir, release, name), 'utf8')
  return JSON.parse(raw) as T
}

afterEach(() => {
  vi.useRealTimers()
})

describe('beam/1 compatibility fixtures', () => {
  it('accepts additive top-level fields on intent frames', () => {
    const identity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
    const frame = hydrateTimestamp(loadFixture<Record<string, unknown>>('intent-forward-compatible.json'))
    signFrame(frame as never, identity.export().privateKeyBase64)

    expect(validateIntentFrame(frame, identity.export().publicKeyBase64)).toEqual({ valid: true })
  })

  it('normalizes legacy params into payload before validation', () => {
    const identity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
    const frame = hydrateTimestamp(loadFixture<Record<string, unknown>>('intent-legacy-params.json'))
    frame['payload'] = frame['params']
    signFrame(frame as never, identity.export().privateKeyBase64)
    delete frame['payload']

    expect(validateIntentFrame(frame, identity.export().publicKeyBase64)).toEqual({ valid: true })
    expect(frame['payload']).toEqual({
      sku: 'INV-240',
      quantity: 240,
      shipTo: 'Mannheim, DE',
    })
  })

  it('accepts additive fields on result frames', () => {
    const identity = BeamIdentity.generate({ agentName: 'partner-desk', orgName: 'northwind' })
    const frame = hydrateTimestamp(loadFixture<Record<string, unknown>>('result-forward-compatible.json'))
    const { signature, ...unsigned } = frame
    frame['signature'] = identity.sign(canonicalizeFrame(unsigned))

    expect(validateResultFrame(frame as never, identity.export().publicKeyBase64)).toEqual({ valid: true })
    expect(signature).toBeDefined()
  })
})

describe('archived beam/1 release fixtures', () => {
  it.each([
    ['v0.6.0', 'intent-forward-compatible.json'],
    ['v0.6.1', 'intent-async-preflight.json'],
  ])('validates archived %s intent fixture %s', (release, name) => {
    const fixture = loadArchivedFixture<{
      release: string
      kind: 'intent'
      signedBy: { beamId: string; publicKeyBase64: string }
      frame: Record<string, unknown>
    }>(release, name)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(String(fixture.frame['timestamp'])))

    expect(validateIntentFrame(structuredClone(fixture.frame), fixture.signedBy.publicKeyBase64)).toEqual({ valid: true })
  })

  it.each([
    ['v0.6.0', 'result-forward-compatible.json', 44160],
    ['v0.6.1', 'result-async-accepted.json', true],
  ])('validates archived %s result fixture %s', (release, name, expectedMarker) => {
    const fixture = loadArchivedFixture<{
      release: string
      kind: 'result'
      signedBy: { beamId: string; publicKeyBase64: string }
      frame: Record<string, unknown>
    }>(release, name)

    expect(validateResultFrame(structuredClone(fixture.frame), fixture.signedBy.publicKeyBase64)).toEqual({ valid: true })
    expect(JSON.stringify(fixture.frame)).toContain(String(expectedMarker))
  })
})
