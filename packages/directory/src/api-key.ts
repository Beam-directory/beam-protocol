import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentRow, OpenClawHostRow } from './types.js'

const AGENT_API_KEY_PREFIX = 'bk_'
const HOST_API_KEY_PREFIX = 'bh_'

type HeaderSource = Headers | Record<string, string | string[] | undefined>

function readHeader(headers: HeaderSource, name: string): string {
  if (headers instanceof Headers) {
    return headers.get(name)?.trim() ?? ''
  }

  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) {
    return (value[0] ?? '').trim()
  }
  return typeof value === 'string' ? value.trim() : ''
}

export function createAgentApiKey(beamId: string): string {
  return `${AGENT_API_KEY_PREFIX}${Buffer.from(beamId, 'utf8').toString('base64url')}.${randomBytes(24).toString('base64url')}`
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

export function buildHostApiKey(hostKey: string, credentialNonce: string): string {
  const derivedSecret = createHash('sha256')
    .update(`beam-openclaw-host:${hostKey}:${credentialNonce}:${process.env['JWT_SECRET'] ?? 'beam-openclaw-host'}`)
    .digest('base64url')
    .slice(0, 32)
  return `${HOST_API_KEY_PREFIX}${Buffer.from(hostKey, 'utf8').toString('base64url')}.${credentialNonce}.${derivedSecret}`
}

export function createHostApiKey(hostKey: string): { credential: string; credentialNonce: string } {
  const credentialNonce = randomBytes(18).toString('base64url')
  return {
    credential: buildHostApiKey(hostKey, credentialNonce),
    credentialNonce,
  }
}

export function getSuppliedApiKey(req: { headers: HeaderSource }): string {
  const headerValue = readHeader(req.headers, 'x-api-key')
  if (headerValue) {
    return headerValue
  }

  const bearer = readHeader(req.headers, 'authorization')
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim()
  }

  return ''
}

export function beamIdFromApiKey(apiKey: string): string | null {
  if (!apiKey.startsWith(AGENT_API_KEY_PREFIX)) {
    return null
  }

  const encodedBeamId = apiKey.slice(AGENT_API_KEY_PREFIX.length).split('.', 1)[0] ?? ''
  if (!encodedBeamId) {
    return null
  }

  try {
    const beamId = Buffer.from(encodedBeamId, 'base64url').toString('utf8')
    return beamId || null
  } catch {
    return null
  }
}

export function hostKeyFromApiKey(apiKey: string): string | null {
  if (!apiKey.startsWith(HOST_API_KEY_PREFIX)) {
    return null
  }

  const encodedHostKey = apiKey.slice(HOST_API_KEY_PREFIX.length).split('.', 1)[0] ?? ''
  if (!encodedHostKey) {
    return null
  }

  try {
    const hostKey = Buffer.from(encodedHostKey, 'base64url').toString('utf8')
    return hostKey || null
  } catch {
    return null
  }
}

export function agentApiKeyMatches(agent: AgentRow | null | undefined, suppliedApiKey: string): boolean {
  if (!agent?.api_key_hash || !suppliedApiKey) {
    return false
  }

  const suppliedHash = hashApiKey(suppliedApiKey)
  return safeCompare(agent.api_key_hash, suppliedHash)
}

export function hostApiKeyMatches(host: OpenClawHostRow | null | undefined, suppliedApiKey: string): boolean {
  if (!host?.credential_hash || !suppliedApiKey) {
    return false
  }

  const suppliedHash = hashApiKey(suppliedApiKey)
  return safeCompare(host.credential_hash, suppliedHash)
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}
