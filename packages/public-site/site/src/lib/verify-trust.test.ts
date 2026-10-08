import { describe, expect, it } from 'vitest'
import { canonicalizeJson, DIRECTORY_SIGNING_PUBLIC_KEY } from 'beam-protocol-sdk/trust-assertion'
import { browserKeyId, checkAgentInBrowser, verifyEd25519InBrowser } from './verify-trust.ts'

const NOW = new Date('2026-10-08T12:00:00.000Z')

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function issuer(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { publicKey: bytesToBase64(spki), privateKey: pair.privateKey }
}

async function signText(text: string, privateKey: CryptoKey): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(text)))
  return bytesToBase64(signature)
}

async function signed(keys: { publicKey: string; privateKey: CryptoKey }, beamId: string, org: unknown) {
  const unsigned = {
    v: 1,
    beamId,
    org,
    person: null,
    mandate: null,
    suspended: false,
    issuedAt: '2026-10-08T11:50:00.000Z',
    expiresAt: '2026-10-08T12:05:00.000Z',
  }
  const signature = await signText(canonicalizeJson(unsigned), keys.privateKey)
  return { ...unsigned, signature, publicKey: keys.publicKey }
}

async function ed25519WebCrypto(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
    return true
  } catch {
    return false
  }
}

const hasEd25519 = await ed25519WebCrypto()

describe('browser trust check', () => {
  it('pins the published directory key id', async () => {
    expect(await browserKeyId(DIRECTORY_SIGNING_PUBLIC_KEY)).toBe('ed25519:9fa8ac307cf1d165')
  })

  it.skipIf(!hasEd25519)('verifies, rejects a tamper, a wrong key, a missing organisation, and an expiry', async () => {
    const keys = await issuer()
    const ok = await signed(keys, 'jarvis@coppen.beam.directory', { name: 'coppen', domain: 'coppen.de', verified: true, registryStatus: 'none' })
    const verified = await checkAgentInBrowser('jarvis@coppen.beam.directory', {
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: keys.publicKey,
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify(ok), { status: 200 }),
    })
    expect(verified.verified).toBe(true)
    expect(verified.signature).toBe('valid')
    expect(await verifyEd25519InBrowser(canonicalizeJson({
      beamId: ok.beamId,
      expiresAt: ok.expiresAt,
      issuedAt: ok.issuedAt,
      mandate: ok.mandate,
      org: ok.org,
      person: ok.person,
      suspended: ok.suspended,
      v: ok.v,
    }), ok.signature, keys.publicKey)).toBe(true)

    const flipped = await checkAgentInBrowser('jarvis@coppen.beam.directory', {
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: keys.publicKey,
      now: NOW,
      tamper: true,
      fetchImpl: async () => new Response(JSON.stringify(ok), { status: 200 }),
    })
    expect(flipped.verified).toBe(false)
    expect(flipped.signature).toBe('tampered')

    const other = await issuer()
    const wrong = await signed(other, 'jarvis@coppen.beam.directory', ok.org)
    const rejected = await checkAgentInBrowser('jarvis@coppen.beam.directory', {
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: keys.publicKey,
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify(wrong), { status: 200 }),
    })
    expect(rejected.signature).toBe('invalid')
    expect(rejected.verified).toBe(false)

    const bare = await signed(keys, 'booking@lufthansa.beam.directory', null)
    const unverified = await checkAgentInBrowser('booking@lufthansa.beam.directory', {
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: keys.publicKey,
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify(bare), { status: 200 }),
    })
    expect(unverified.verified).toBe(false)
    expect(unverified.signature).toBe('valid')
    expect(unverified.detail).toBe('no_org')

    const expired = await checkAgentInBrowser('jarvis@coppen.beam.directory', {
      directoryUrl: 'https://directory.test',
      pinnedPublicKey: keys.publicKey,
      now: new Date('2026-10-08T13:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify(ok), { status: 200 }),
    })
    expect(expired.signature).toBe('valid')
    expect(expired.expired).toBe(true)
    expect(expired.verified).toBe(false)
    expect(expired.detail).toBe('expired')
  })
})
