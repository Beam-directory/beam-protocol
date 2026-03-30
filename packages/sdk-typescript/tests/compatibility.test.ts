import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BeamIdentity, canonicalizeFrame, signFrame, validateIntentFrame, validateResultFrame } from '../src/index.js'

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../spec/fixtures/compatibility')

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
