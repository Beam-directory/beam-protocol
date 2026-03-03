import { describe, it, expect } from 'vitest'
import { BeamIdentity } from '../src/identity.js'

describe('BeamIdentity', () => {
  it('generate() creates valid beamId format', () => {
    const identity = BeamIdentity.generate({ agentName: 'myagent', orgName: 'myorg' })
    expect(identity.beamId).toBe('myagent@myorg.beam.directory')
    expect(identity.publicKeyBase64).toBeTruthy()
    expect(typeof identity.publicKeyBase64).toBe('string')
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
    // Flip a character in the signature
    const tampered = signature.slice(0, -4) + 'AAAA'
    const valid = BeamIdentity.verify(data, tampered, identity.publicKeyBase64)
    expect(valid).toBe(false)
  })

  it('verify() returns false for wrong public key', () => {
    const identity1 = BeamIdentity.generate({ agentName: 'alice', orgName: 'acme' })
    const identity2 = BeamIdentity.generate({ agentName: 'bob', orgName: 'acme' })
    const data = 'hello beam protocol'
    const signature = identity1.sign(data)
    // Verify with wrong key
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

    // Signing with restored key should verify against original public key
    const message = 'test round trip'
    const sig = restored.sign(message)
    expect(BeamIdentity.verify(message, sig, original.publicKeyBase64)).toBe(true)
  })

  it('export() produces stable base64 keys', () => {
    const identity = BeamIdentity.generate({ agentName: 'stable', orgName: 'org' })
    const export1 = identity.export()
    const export2 = identity.export()
    expect(export1.publicKeyBase64).toBe(export2.publicKeyBase64)
    expect(export1.privateKeyBase64).toBe(export2.privateKeyBase64)
  })

  describe('parseBeamId()', () => {
    it('returns correct agent/org for valid beam ID', () => {
      const result = BeamIdentity.parseBeamId('myagent@myorg.beam.directory')
      expect(result).not.toBeNull()
      expect(result!.agent).toBe('myagent')
      expect(result!.org).toBe('myorg')
    })

    it('returns correct result for hyphenated names', () => {
      const result = BeamIdentity.parseBeamId('my-agent@my-org.beam.directory')
      expect(result).not.toBeNull()
      expect(result!.agent).toBe('my-agent')
      expect(result!.org).toBe('my-org')
    })

    it('returns correct result for underscore names', () => {
      const result = BeamIdentity.parseBeamId('my_agent@my_org.beam.directory')
      expect(result).not.toBeNull()
      expect(result!.agent).toBe('my_agent')
      expect(result!.org).toBe('my_org')
    })

    it('returns null for invalid format - missing @', () => {
      expect(BeamIdentity.parseBeamId('myagentmyorg.beam.directory')).toBeNull()
    })

    it('returns null for invalid format - wrong suffix', () => {
      expect(BeamIdentity.parseBeamId('myagent@myorg.beam.com')).toBeNull()
    })

    it('returns null for invalid format - uppercase letters', () => {
      expect(BeamIdentity.parseBeamId('MyAgent@myorg.beam.directory')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(BeamIdentity.parseBeamId('')).toBeNull()
    })

    it('returns null for partial match', () => {
      expect(BeamIdentity.parseBeamId('agent@org.beam.directory.extra')).toBeNull()
    })
  })

  it('generateNonce() returns a UUID v4 string', () => {
    const nonce = BeamIdentity.generateNonce()
    expect(typeof nonce).toBe('string')
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generateNonce() returns unique values', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => BeamIdentity.generateNonce()))
    expect(nonces.size).toBe(100)
  })
})
