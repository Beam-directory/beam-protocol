import { describe, it, expect } from 'vitest'
import { BeamIdentity } from '../src/identity.js'

describe('BeamIdentity', () => {
  it('generate() creates valid organizational beamId format', () => {
    const identity = BeamIdentity.generate({ agentName: 'myagent', orgName: 'myorg' })
    expect(identity.beamId).toBe('myagent@myorg.beam.directory')
    expect(identity.publicKeyBase64).toBeTruthy()
    expect(typeof identity.publicKeyBase64).toBe('string')
  })

  it('generate() supports consumer beam IDs', () => {
    const identity = BeamIdentity.generate({ agentName: 'alice' })
    expect(identity.beamId).toBe('alice@beam.directory')
  })

  it('sign() + verify() round-trip works', () => {
    const identity = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const data = 'hello beam protocol'
    const signature = identity.sign(data)
    expect(typeof signature).toBe('string')
    expect(signature.length).toBeGreaterThan(0)
    const valid = BeamIdentity.verify(data, signature, identity.publicKeyBase64)
    expect(valid).toBe(true)
  })

  it('verify() returns false for tampered data', () => {
    const identity = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const data = 'original message'
    const signature = identity.sign(data)
    const valid = BeamIdentity.verify('tampered message', signature, identity.publicKeyBase64)
    expect(valid).toBe(false)
  })

  it('verify() returns false for tampered signature', () => {
    const identity = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const data = 'hello beam protocol'
    const signature = identity.sign(data)
    const tampered = signature.slice(0, -4) + 'AAAA'
    const valid = BeamIdentity.verify(data, tampered, identity.publicKeyBase64)
    expect(valid).toBe(false)
  })

  it('verify() returns false for wrong public key', () => {
    const identity1 = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const identity2 = BeamIdentity.generate({ agentName: 'bob', orgName: 'acme' })
    const data = 'hello beam protocol'
    const signature = identity1.sign(data)
    const valid = BeamIdentity.verify(data, signature, identity2.publicKeyBase64)
    expect(valid).toBe(false)
  })

  it('export() + fromData() round-trip works', () => {
    const original = BeamIdentity.generate({ agentName: 'testbot', orgName: 'testorg' })
    const data = original.export()

    expect(data.beamId).toBe('testbot@testorg.beam.directory')
    expect(typeof data.publicKeyBase64).toBe('string')
    expect(typeof data.privateKeyBase64).toBe('string')

    const restored = BeamIdentity.fromData(data)
    expect(restored.beamId).toBe(original.beamId)
    expect(restored.publicKeyBase64).toBe(original.publicKeyBase64)

    const message = 'test round trip'
    const sig = restored.sign(message)
    expect(BeamIdentity.verify(message, sig, original.publicKeyBase64)).toBe(true)
  })

  describe('parseBeamId()', () => {
    it('returns correct agent/org for valid organizational beam ID', () => {
      const result = BeamIdentity.parseBeamId('myagent@myorg.beam.directory')
      expect(result).not.toBeNull()
      expect(result).toEqual({ agent: 'myagent', org: 'myorg', kind: 'organization' })
    })

    it('returns correct result for consumer beam IDs', () => {
      const result = BeamIdentity.parseBeamId('alice@beam.directory')
      expect(result).toEqual({ agent: 'alice', kind: 'consumer' })
    })

    it('returns correct result for hyphenated names', () => {
      const result = BeamIdentity.parseBeamId('my-agent@my-org.beam.directory')
      expect(result).toEqual({ agent: 'my-agent', org: 'my-org', kind: 'organization' })
    })

    it('returns null for invalid format', () => {
      expect(BeamIdentity.parseBeamId('myagentmyorg.beam.directory')).toBeNull()
      expect(BeamIdentity.parseBeamId('myagent@myorg.beam.com')).toBeNull()
      expect(BeamIdentity.parseBeamId('MyAgent@myorg.beam.directory')).toBeNull()
      expect(BeamIdentity.parseBeamId('')).toBeNull()
      expect(BeamIdentity.parseBeamId('agent@org.beam.directory.extra')).toBeNull()
    })
  })

  it('generateNonce() returns a UUID v4 string', () => {
    const nonce = BeamIdentity.generateNonce()
    expect(typeof nonce).toBe('string')
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generateNonce() returns unique values', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => BeamIdentity.generateNonce()))
    expect(nonces.size).toBe(100)
  })
})
