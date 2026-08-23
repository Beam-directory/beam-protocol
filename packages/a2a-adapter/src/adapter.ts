import { randomUUID } from 'node:crypto'
import type {
  A2AAgentCard,
  A2AMessage,
  A2APart,
  A2ATask,
  BeamAgentLike,
  BeamIntentDraft,
  BeamResultLike,
  JsonObject,
  JsonValue,
} from './types.js'

export const A2A_PROTOCOL_VERSION = '1.0' as const
export const BEAM_TRUST_EXTENSION = 'https://beam.directory/extensions/trust/v1'
export const MAX_BEAM_PAYLOAD_BYTES = 4 * 1024

const BEAM_ID_RE = /^[a-z0-9][a-z0-9._-]*@(?:[a-z0-9-]+\.)*beam\.directory$/i
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_CAPABILITY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i

export class A2AAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'A2AAdapterError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1))
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, entry]) => key.length <= 256 && isJsonValue(entry, depth + 1))
}

function asIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_RE.test(value)) {
    throw new A2AAdapterError('INVALID_A2A_MESSAGE', `${field} must be a non-empty opaque identifier of at most 256 characters`)
  }
  return value
}

function asOptionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : asIdentifier(value, field)
}

function asStringList(value: unknown, field: string, maxItems = 32): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512)) {
    throw new A2AAdapterError('INVALID_A2A_MESSAGE', `${field} must be an array of bounded non-empty strings`)
  }
  return [...value]
}

function parsePart(value: unknown): A2APart {
  if (!isRecord(value)) {
    throw new A2AAdapterError('INVALID_A2A_PART', 'Each A2A part must be an object')
  }

  const discriminators = ['text', 'raw', 'url', 'data'].filter((field) => Object.hasOwn(value, field))
  if (discriminators.length !== 1) {
    throw new A2AAdapterError('INVALID_A2A_PART', 'An A2A v1 part must contain exactly one of text, raw, url, or data')
  }

  if (discriminators[0] === 'raw') {
    throw new A2AAdapterError('INLINE_FILE_NOT_ALLOWED', 'Inline A2A file bytes are not accepted by the Beam 4 KB frame; use an authorized HTTPS URL')
  }

  const part: A2APart = {}
  if (discriminators[0] === 'text') {
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 3_000) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'Text parts must contain 1-3000 characters')
    }
    part.text = value.text
  } else if (discriminators[0] === 'url') {
    if (typeof value.url !== 'string' || value.url.length > 2_048) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'File URL must be a bounded HTTPS URL')
    }
    let parsed: URL
    try {
      parsed = new URL(value.url)
    } catch {
      throw new A2AAdapterError('INVALID_A2A_PART', 'File URL must be a valid absolute URL')
    }
    if (parsed.protocol !== 'https:') {
      throw new A2AAdapterError('UNSAFE_FILE_URL', 'Only HTTPS file URLs are accepted')
    }
    part.url = parsed.toString()
  } else {
    if (!isJsonValue(value.data)) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'Data part must be bounded JSON data')
    }
    part.data = value.data
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || !isJsonValue(value.metadata)) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'Part metadata must be JSON object data')
    }
    part.metadata = value.metadata as JsonObject
  }
  if (value.filename !== undefined) {
    if (typeof value.filename !== 'string' || value.filename.length > 255 || /[/\\\0]/.test(value.filename)) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'filename must be a plain filename')
    }
    part.filename = value.filename
  }
  if (value.mediaType !== undefined) {
    if (typeof value.mediaType !== 'string' || value.mediaType.length > 255 || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mediaType)) {
      throw new A2AAdapterError('INVALID_A2A_PART', 'mediaType must be a valid MIME type')
    }
    part.mediaType = value.mediaType
  }
  return part
}

export function parseA2AMessage(value: unknown): A2AMessage {
  if (!isRecord(value)) {
    throw new A2AAdapterError('INVALID_A2A_MESSAGE', 'A2A message must be an object')
  }
  if (value.role !== 'ROLE_USER' && value.role !== 'ROLE_AGENT') {
    throw new A2AAdapterError('INVALID_A2A_MESSAGE', 'role must be ROLE_USER or ROLE_AGENT')
  }
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 16) {
    throw new A2AAdapterError('INVALID_A2A_MESSAGE', 'parts must contain between 1 and 16 entries')
  }

  const message: A2AMessage = {
    messageId: asIdentifier(value.messageId, 'messageId'),
    role: value.role,
    parts: value.parts.map(parsePart),
  }
  message.contextId = asOptionalIdentifier(value.contextId, 'contextId')
  message.taskId = asOptionalIdentifier(value.taskId, 'taskId')
  message.referenceTaskIds = asStringList(value.referenceTaskIds, 'referenceTaskIds')
  message.extensions = asStringList(value.extensions, 'extensions')
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || !isJsonValue(value.metadata)) {
      throw new A2AAdapterError('INVALID_A2A_MESSAGE', 'metadata must be JSON object data')
    }
    message.metadata = value.metadata as JsonObject
  }
  return message
}

export function a2aMessageToBeamIntent(input: {
  message: unknown
  from: string
  to: string
}): BeamIntentDraft {
  if (!BEAM_ID_RE.test(input.from) || !BEAM_ID_RE.test(input.to)) {
    throw new A2AAdapterError('INVALID_BEAM_ID', 'from and to must be valid Beam IDs')
  }
  const message = parseA2AMessage(input.message)
  const text = message.parts
    .flatMap((part) => part.text === undefined ? [] : [part.text])
    .join('\n\n')

  const payload: JsonObject = {
    message: text || `A2A message ${message.messageId}`,
    a2a: {
      protocolVersion: A2A_PROTOCOL_VERSION,
      messageId: message.messageId,
      role: message.role,
      parts: message.parts as JsonValue,
      ...(message.contextId ? { contextId: message.contextId } : {}),
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.referenceTaskIds ? { referenceTaskIds: message.referenceTaskIds } : {}),
      ...(message.extensions ? { extensions: message.extensions } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
    },
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (bytes > MAX_BEAM_PAYLOAD_BYTES) {
    throw new A2AAdapterError('BEAM_PAYLOAD_TOO_LARGE', `Mapped payload is ${bytes} bytes; Beam v1 allows ${MAX_BEAM_PAYLOAD_BYTES}`)
  }

  return { intent: 'conversation.message', from: input.from, to: input.to, payload }
}

export function beamResultToA2ATask(input: {
  result: BeamResultLike
  taskId: string
  contextId: string
}): A2ATask {
  const taskId = asIdentifier(input.taskId, 'taskId')
  const contextId = asIdentifier(input.contextId, 'contextId')
  const timestamp = Number.isFinite(Date.parse(input.result.timestamp))
    ? new Date(input.result.timestamp).toISOString()
    : new Date().toISOString()
  const metadata: JsonObject = {
    beamNonce: input.result.nonce,
    ...(input.result.errorCode ? { beamErrorCode: input.result.errorCode } : {}),
    ...(typeof input.result.latency === 'number' && Number.isFinite(input.result.latency)
      ? { beamLatencyMs: input.result.latency }
      : {}),
  }

  if (!input.result.success) {
    return {
      id: taskId,
      contextId,
      status: {
        state: input.result.errorCode === 'ACL_DENIED' ? 'TASK_STATE_REJECTED' : 'TASK_STATE_FAILED',
        timestamp,
        message: {
          messageId: randomUUID(),
          contextId,
          taskId,
          role: 'ROLE_AGENT',
          parts: [{ text: input.result.error ?? 'Beam handoff failed' }],
        },
      },
      metadata,
    }
  }

  const payload = input.result.payload ?? {}
  if (!isJsonValue(payload)) {
    throw new A2AAdapterError('INVALID_BEAM_RESULT', 'Beam result payload is not JSON-safe')
  }
  const parts: A2APart[] = []
  const message = typeof payload['message'] === 'string' ? payload['message'] : null
  if (message) parts.push({ text: message })
  parts.push({ data: payload as JsonObject, mediaType: 'application/json' })

  return {
    id: taskId,
    contextId,
    status: { state: 'TASK_STATE_COMPLETED', timestamp },
    artifacts: [{
      artifactId: randomUUID(),
      name: 'Beam handoff result',
      parts,
      metadata,
    }],
    metadata,
  }
}

function assertHttpsUrl(value: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new A2AAdapterError('INVALID_AGENT_CARD', `${field} must be an absolute HTTPS URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new A2AAdapterError('INVALID_AGENT_CARD', `${field} must use HTTPS`)
  }
  return parsed.toString()
}

function skillName(capability: string): string {
  return capability
    .split(/[._-]+/)
    .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : '')
    .join(' ')
}

export function beamAgentToA2ACard(input: {
  agent: BeamAgentLike
  a2aUrl: string
  providerUrl?: string
  documentationUrl?: string
  tenant?: string
}): A2AAgentCard {
  if (!BEAM_ID_RE.test(input.agent.beamId)) {
    throw new A2AAdapterError('INVALID_BEAM_ID', 'agent.beamId must be a valid Beam ID')
  }
  if (!input.agent.displayName.trim() || !input.agent.capabilities.length) {
    throw new A2AAdapterError('INVALID_AGENT_CARD', 'Agent name and at least one capability are required')
  }
  if (!input.agent.capabilities.every((capability) => SAFE_CAPABILITY_RE.test(capability))) {
    throw new A2AAdapterError('INVALID_AGENT_CARD', 'Capabilities must use stable, URL-safe identifiers')
  }
  const a2aUrl = assertHttpsUrl(input.a2aUrl, 'a2aUrl')
  const providerUrl = input.providerUrl ? assertHttpsUrl(input.providerUrl, 'providerUrl') : undefined
  const documentationUrl = input.documentationUrl
    ? assertHttpsUrl(input.documentationUrl, 'documentationUrl')
    : undefined
  const tenant = input.tenant === undefined ? undefined : asIdentifier(input.tenant, 'tenant')

  return {
    name: input.agent.displayName.trim(),
    description: input.agent.description?.trim() || `A2A interface for ${input.agent.beamId}`,
    supportedInterfaces: [{
      url: a2aUrl,
      protocolBinding: 'HTTP+JSON',
      protocolVersion: A2A_PROTOCOL_VERSION,
      ...(tenant ? { tenant } : {}),
    }],
    ...(providerUrl ? { provider: { organization: input.agent.org ?? 'Beam agent operator', url: providerUrl } } : {}),
    version: input.agent.version ?? '1.0.0',
    ...(documentationUrl ? { documentationUrl } : {}),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [{
        uri: BEAM_TRUST_EXTENSION,
        description: 'Beam identity assurance, policy, approval, and audit metadata',
        required: false,
      }],
    },
    securitySchemes: {
      beamBearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          bearerFormat: 'BeamAPIKey',
          description: 'Scoped Beam agent or delegated access token',
        },
      },
    },
    securityRequirements: [{ schemes: { beamBearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: input.agent.capabilities.map((capability) => ({
      id: capability,
      name: skillName(capability),
      description: `Beam capability ${capability}`,
      tags: ['beam', ...capability.split(/[._-]+/).filter(Boolean)],
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain', 'application/json'],
    })),
  }
}
