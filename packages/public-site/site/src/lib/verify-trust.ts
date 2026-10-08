import {
  DEFAULT_DIRECTORY_URL,
  DIRECTORY_SIGNING_PUBLIC_KEY,
  assertionSigningText,
  decodeBase64,
  evaluateTrustCheck,
  flipSignatureByte,
  keyIdFromSha256Hex,
  parseBeamAddress,
  type AgentCheck,
} from 'beam-protocol-sdk/trust-assertion'

const MAX_BODY_BYTES = 65_536

export interface BrowserCheckOptions {
  directoryUrl?: string
  pinnedPublicKey?: string
  fetchImpl?: typeof fetch
  now?: Date
  tamper?: boolean
  signal?: AbortSignal
}

function configured(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function directoryUrl(): string {
  return configured('VITE_DIRECTORY_API_URL') || DEFAULT_DIRECTORY_URL
}

export function pinnedDirectoryKey(): string {
  return configured('VITE_DIRECTORY_SIGNING_PUBLIC_KEY') || DIRECTORY_SIGNING_PUBLIC_KEY
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function browserKeyId(publicKeyBase64: string): Promise<string | null> {
  const bytes = decodeBase64(publicKeyBase64)
  if (!bytes || bytes.length === 0) return null
  return keyIdFromSha256Hex(await sha256Hex(bytes))
}

export async function verifyEd25519InBrowser(message: string, signatureBase64: string, publicKeyBase64: string): Promise<boolean> {
  try {
    const signature = decodeBase64(signatureBase64)
    const publicKey = decodeBase64(publicKeyBase64)
    if (!signature || !publicKey) return false
    const key = await crypto.subtle.importKey('spki', publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength) as ArrayBuffer, { name: 'Ed25519' }, false, ['verify'])
    const data = new TextEncoder().encode(message)
    return crypto.subtle.verify({ name: 'Ed25519' }, key, signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer, data)
  } catch {
    return false
  }
}

function failed(address: string, pinnedKeyId: string, httpStatus: number | null, nowMs: number): Promise<AgentCheck> {
  return Promise.resolve(evaluateTrustCheck({
    address,
    httpStatus,
    body: null,
    signatureValid: false,
    tampered: false,
    pinnedPublicKey: pinnedDirectoryKey(),
    pinnedKeyId,
    assertionKeyId: null,
    nowMs,
  }))
}

/** Fetch the public assertion and verify it with WebCrypto. No credentials, no writes. */
export async function checkAgentInBrowser(address: string, options: BrowserCheckOptions = {}): Promise<AgentCheck> {
  const pinnedPublicKey = options.pinnedPublicKey?.trim() || pinnedDirectoryKey()
  const pinnedKeyId = (await browserKeyId(pinnedPublicKey)) ?? 'ed25519:unknown'
  const nowMs = options.now?.getTime() ?? Date.now()
  const parsed = parseBeamAddress(address)
  if (!parsed) {
    return evaluateTrustCheck({
      address,
      httpStatus: 400,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs,
    })
  }

  const base = (options.directoryUrl?.trim() || directoryUrl()).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${base}/agents/${encodeURIComponent(parsed)}/trust-assertion`, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: options.signal,
    })
  } catch {
    return failed(parsed, pinnedKeyId, null, nowMs)
  }

  if (response.status >= 300 && response.status < 400) return failed(parsed, pinnedKeyId, null, nowMs)
  if (response.status !== 200) {
    return evaluateTrustCheck({
      address: parsed,
      httpStatus: response.status,
      body: null,
      signatureValid: false,
      tampered: false,
      pinnedPublicKey,
      pinnedKeyId,
      assertionKeyId: null,
      nowMs,
    })
  }

  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) return failed(parsed, pinnedKeyId, 200, nowMs)
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return failed(parsed, pinnedKeyId, 200, nowMs)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failed(parsed, pinnedKeyId, 200, nowMs)
  const record = body as Record<string, unknown>
  const signature = typeof record['signature'] === 'string' ? record['signature'] : ''
  const tampered = options.tamper === true
  const signatureToCheck = tampered ? flipSignatureByte(signature) : signature
  const signatureValid = await verifyEd25519InBrowser(assertionSigningText(record), signatureToCheck, pinnedPublicKey)
  const echoedKey = typeof record['publicKey'] === 'string' ? record['publicKey'] : ''
  return evaluateTrustCheck({
    address: parsed,
    httpStatus: 200,
    body: record,
    signatureValid,
    tampered,
    pinnedPublicKey,
    pinnedKeyId,
    assertionKeyId: await browserKeyId(echoedKey),
    nowMs,
  })
}

export { flipSignatureByte, parseBeamAddress }
export type { AgentCheck }
