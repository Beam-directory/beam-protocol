import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentRow } from './types.js'

const AGENT_API_KEY_PREFIX = 'bk_'

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

export function agentApiKeyMatches(agent: AgentRow | null | undefined, suppliedApiKey: string): boolean {
  if (!agent?.api_key_hash || !suppliedApiKey) {
    return false
  }

  const suppliedHash = hashApiKey(suppliedApiKey)
  return safeCompare(agent.api_key_hash, suppliedHash)
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}
