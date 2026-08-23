export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type A2ARole = 'ROLE_USER' | 'ROLE_AGENT'

export type A2APart = {
  text?: string
  raw?: string
  url?: string
  data?: JsonValue
  metadata?: JsonObject
  filename?: string
  mediaType?: string
}

export interface A2AMessage {
  messageId: string
  role: A2ARole
  parts: A2APart[]
  contextId?: string
  taskId?: string
  metadata?: JsonObject
  extensions?: string[]
  referenceTaskIds?: string[]
}

export interface A2AAgentCard {
  name: string
  description: string
  supportedInterfaces: Array<{
    url: string
    protocolBinding: 'HTTP+JSON'
    protocolVersion: '1.0'
    tenant?: string
  }>
  provider?: { organization: string; url: string }
  version: string
  documentationUrl?: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    extendedAgentCard: boolean
    extensions: Array<{ uri: string; description: string; required: boolean }>
  }
  securitySchemes: {
    beamBearer: {
      httpAuthSecurityScheme: {
        scheme: 'Bearer'
        bearerFormat: 'BeamAPIKey'
        description: string
      }
    }
  }
  securityRequirements: Array<{
    schemes: { beamBearer: { list: string[] } }
  }>
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: Array<{
    id: string
    name: string
    description: string
    tags: string[]
    inputModes: string[]
    outputModes: string[]
  }>
}

export interface A2ATask {
  id: string
  contextId: string
  status: {
    state: 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_REJECTED'
    timestamp: string
    message?: A2AMessage
  }
  artifacts?: Array<{
    artifactId: string
    name: string
    parts: A2APart[]
    metadata?: JsonObject
  }>
  metadata?: JsonObject
}

export interface BeamIntentDraft {
  intent: 'conversation.message'
  from: string
  to: string
  payload: JsonObject
}

export interface BeamResultLike {
  nonce: string
  success: boolean
  timestamp: string
  payload?: Record<string, unknown>
  error?: string
  errorCode?: string
  latency?: number
}

export interface BeamAgentLike {
  beamId: string
  displayName: string
  description?: string | null
  org?: string | null
  capabilities: string[]
  version?: string
}
