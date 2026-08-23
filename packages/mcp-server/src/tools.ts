import { createHash } from 'node:crypto'
import type {
  AgentRecord,
  AgentProfile,
  BeamIdString,
  DirectoryStats,
  ResultFrame,
  VerificationTier,
} from 'beam-protocol-sdk'

const MAX_MESSAGE_BYTES = 4_096
const MAX_CONTEXT_BYTES = 16_384
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const VERIFICATION_TIER_RANK: Record<VerificationTier, number> = {
  basic: 0,
  verified: 1,
  business: 2,
  enterprise: 3,
}

type AssuranceAwareAgent = AgentProfile & {
  assuranceScope?: 'local' | 'federated-untrusted'
  assuranceIssuer?: string
  remoteAssurance?: {
    issuer: string
    verified: boolean
    tier: VerificationTier | null
    status: string | null
    trustScore: number | null
  }
}

export interface BeamGateway {
  getStats(): Promise<DirectoryStats>
  lookup(beamId: BeamIdString): Promise<AgentRecord | null>
  send(
    to: BeamIdString,
    intent: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ResultFrame>
}

export interface BeamStatusInput {
  target?: string
}

export interface BeamPrepareHandoffInput {
  to: string
  message: string
  intent?: string
  context?: Record<string, unknown>
}

export interface BeamSendInput extends BeamPrepareHandoffInput {
  confirmed: boolean
  timeoutMs?: number
}

export interface BeamToolHandlers {
  status(input: BeamStatusInput): Promise<Record<string, unknown>>
  prepareHandoff(input: BeamPrepareHandoffInput): Promise<Record<string, unknown>>
  send(input: BeamSendInput): Promise<Record<string, unknown>>
}

function parseBeamId(value: string): BeamIdString {
  const trimmed = value.trim()
  if (!/^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/.test(trimmed)) {
    throw new Error('Target must be a valid lowercase Beam ID')
  }
  return trimmed as BeamIdString
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

function validatePayload(input: BeamPrepareHandoffInput, allowedIntents: ReadonlySet<string>): {
  to: BeamIdString
  intent: string
  payload: Record<string, unknown>
} {
  const to = parseBeamId(input.to)
  const intent = input.intent?.trim() || 'conversation.message'
  if (!allowedIntents.has(intent)) {
    throw new Error(`Intent is not allowed by this MCP server: ${intent}`)
  }
  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    throw new Error('Message must be non-empty')
  }
  if (byteLength(input.message) > MAX_MESSAGE_BYTES) {
    throw new Error(`Message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes`)
  }
  if (input.context !== undefined && byteLength(input.context) > MAX_CONTEXT_BYTES) {
    throw new Error(`Context exceeds ${MAX_CONTEXT_BYTES} UTF-8 bytes`)
  }

  return {
    to,
    intent,
    payload: {
      message: input.message,
      ...(input.context === undefined ? {} : { context: input.context }),
    },
  }
}

function publicAgent(agent: AgentRecord): Record<string, unknown> {
  const profile = agent as AssuranceAwareAgent
  const federatedUntrusted = profile.assuranceScope === 'federated-untrusted'
  const verificationTier = federatedUntrusted
    ? 'basic'
    : profile.verificationTier ?? (agent.verified ? 'verified' : 'basic')
  const verificationStatus = federatedUntrusted
    ? 'unverified'
    : profile.verificationStatus ?? (agent.verified ? 'verified' : 'unverified')
  return {
    beamId: agent.beamId,
    displayName: agent.displayName,
    organization: agent.org || null,
    capabilities: agent.capabilities,
    verified: federatedUntrusted ? false : agent.verified,
    verificationTier,
    verificationStatus,
    trustScore: agent.trustScore,
    assurance: {
      tier: verificationTier,
      status: verificationStatus,
      independentlyVerified: federatedUntrusted ? false : agent.verified,
      trustScore: agent.trustScore,
      scope: profile.assuranceScope ?? 'local-directory',
      issuer: profile.assuranceIssuer ?? null,
      remoteAssertion: profile.remoteAssurance ?? null,
    },
    lastSeen: agent.lastSeen,
  }
}

async function requireTarget(gateway: BeamGateway, to: BeamIdString): Promise<AgentRecord> {
  const target = await gateway.lookup(to)
  if (!target) {
    throw new Error(`Beam target not found: ${to}`)
  }
  return target
}

function warningsFor(
  target: AgentRecord,
  intent: string,
  policy: { requireVerifiedTarget: boolean; minimumVerificationTier: VerificationTier; minimumTrustScore: number },
): string[] {
  const warnings: string[] = []
  const profile = target as AssuranceAwareAgent
  const federatedUntrusted = profile.assuranceScope === 'federated-untrusted'
  if (policy.requireVerifiedTarget && (!target.verified || federatedUntrusted)) {
    warnings.push('Target identity is not independently verified')
  }
  const verificationTier = federatedUntrusted
    ? 'basic'
    : profile.verificationTier ?? (target.verified ? 'verified' : 'basic')
  if (VERIFICATION_TIER_RANK[verificationTier] < VERIFICATION_TIER_RANK[policy.minimumVerificationTier]) {
    warnings.push(`Target verification tier ${verificationTier} is below required ${policy.minimumVerificationTier}`)
  }
  if (target.trustScore < policy.minimumTrustScore) {
    warnings.push(`Target trust score is below ${policy.minimumTrustScore}`)
  }
  if (target.capabilities.length > 0 && !target.capabilities.includes(intent)) {
    warnings.push(`Target does not advertise the requested intent: ${intent}`)
  }
  return warnings
}

export function createBeamToolHandlers(options: {
  gateway: BeamGateway
  ownBeamId: BeamIdString
  allowedIntents: ReadonlySet<string>
  requireVerifiedTarget?: boolean
  minimumVerificationTier?: VerificationTier
  minimumTrustScore?: number
}): BeamToolHandlers {
  const { gateway, ownBeamId, allowedIntents } = options
  const requireVerifiedTarget = options.requireVerifiedTarget ?? true
  const policy = {
    requireVerifiedTarget,
    minimumVerificationTier: options.minimumVerificationTier ?? (requireVerifiedTarget ? 'verified' : 'basic'),
    minimumTrustScore: options.minimumTrustScore ?? 0.5,
  }

  return {
    async status(input) {
      const [stats, ownAgent, target] = await Promise.all([
        gateway.getStats(),
        gateway.lookup(ownBeamId),
        input.target ? gateway.lookup(parseBeamId(input.target)) : Promise.resolve(null),
      ])
      return {
        connectedAs: ownBeamId,
        registered: ownAgent !== null,
        ownAgent: ownAgent ? publicAgent(ownAgent) : null,
        target: target ? publicAgent(target) : null,
        directory: {
          totalAgents: stats.totalAgents,
          verifiedAgents: stats.verifiedAgents,
          intentsProcessed: stats.intentsProcessed,
          version: stats.version ?? null,
        },
      }
    },

    async prepareHandoff(input) {
      const validated = validatePayload(input, allowedIntents)
      const target = await requireTarget(gateway, validated.to)
      const warnings = warningsFor(target, validated.intent, policy)
      return {
        ready: warnings.length === 0,
        requiresHumanConfirmation: true,
        from: ownBeamId,
        to: validated.to,
        intent: validated.intent,
        messageBytes: byteLength(input.message),
        messageSha256: createHash('sha256').update(input.message, 'utf8').digest('hex'),
        target: publicAgent(target),
        warnings,
      }
    },

    async send(input) {
      if (input.confirmed !== true) {
        throw new Error('External delivery blocked: set confirmed=true only after explicit human approval')
      }
      const validated = validatePayload(input, allowedIntents)
      const target = await requireTarget(gateway, validated.to)
      const warnings = warningsFor(target, validated.intent, policy)
      if (warnings.length > 0) {
        throw new Error(`Beam target policy blocked delivery: ${warnings.join('; ')}`)
      }
      const timeoutMs = input.timeoutMs ?? 60_000
      if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
      }

      const result = await gateway.send(validated.to, validated.intent, validated.payload, timeoutMs)
      return {
        delivered: true,
        from: ownBeamId,
        to: validated.to,
        intent: validated.intent,
        target: publicAgent(target),
        result: {
          success: result.success,
          payload: result.payload ?? null,
          error: result.error ?? null,
          errorCode: result.errorCode ?? null,
          nonce: result.nonce,
          timestamp: result.timestamp,
          latency: result.latency ?? null,
          signed: typeof result.signature === 'string' && result.signature.length > 0,
        },
      }
    },
  }
}
