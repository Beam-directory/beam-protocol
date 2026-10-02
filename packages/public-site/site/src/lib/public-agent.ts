const VERIFIED_TIERS = new Set(['verified', 'business', 'enterprise'])

export interface PublicAgentView {
  beamId: string
  displayName: string
  org: string
  tier: string
  verified: boolean
  did: string
  description: string | null
  website: string | null
  createdAt: string | null
  publicKey: string | null
  legalName: string | null
  registrationNumber: string | null
  registerCourt: string | null
  country: string | null
  domain: string | null
  domainVerified: boolean
  verifiedAt: string | null
  keyStatus: 'active' | 'revoked' | 'unknown'
}

export type PublicAgentDecision =
  | { ok: true; agent: PublicAgentView }
  | { ok: false; reason: 'invalid' | 'not-public' | 'email-present' | 'personal' | 'unverified' }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function containsEmail(value: unknown): boolean {
  if (typeof value === 'string') {
    return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsEmail(entry))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => {
      if (key === 'did' || key === 'beam_id' || key === 'beamId' || key === 'website') {
        return false
      }
      return containsEmail(entry)
    })
  }
  return false
}

function tierOf(record: Record<string, unknown>): string {
  return (text(record.verificationTier) ?? text(record.verification_tier) ?? 'basic').toLowerCase()
}

function isVerified(record: Record<string, unknown>, tier: string): boolean {
  return record.verified === true || VERIFIED_TIERS.has(tier)
}

export function projectPublicAgent(payload: unknown, extras?: {
  business?: unknown
  domain?: unknown
}): PublicAgentDecision {
  const record = asRecord(payload)
  if (!record) {
    return { ok: false, reason: 'invalid' }
  }

  if (text(record.email) || text(record.email_token) || text(record.api_key_hash)) {
    return { ok: false, reason: 'email-present' }
  }

  const beamId = text(record.beam_id) ?? text(record.beamId)
  if (!beamId) {
    return { ok: false, reason: 'invalid' }
  }

  if (record.personal === true || record.visibility === 'unlisted' || record.flagged === true) {
    return { ok: false, reason: record.personal === true ? 'personal' : 'not-public' }
  }

  if (record.visibility !== 'public') {
    return { ok: false, reason: 'not-public' }
  }

  const org = text(record.org)
  if (!org) {
    return { ok: false, reason: 'not-public' }
  }

  const tier = tierOf(record)
  const verified = isVerified(record, tier)
  const business = asRecord(extras?.business)
  const businessVerification = asRecord(business?.businessVerification)
  const domainStatus = asRecord(extras?.domain)
  const domainName = text(domainStatus?.domain)
  const domainVerified = domainStatus?.status === 'verified' && Boolean(domainName)

  const safePayload = {
    beamId,
    displayName: text(record.display_name) ?? text(record.displayName) ?? beamId,
    org,
    tier,
    verified,
    description: text(record.description),
    website: text(record.website),
    createdAt: text(record.created_at) ?? text(record.createdAt),
    publicKey: text(record.public_key) ?? text(record.publicKey),
    legalName: text(businessVerification?.legalName),
    registrationNumber: text(businessVerification?.registrationNumber),
    country: text(businessVerification?.country),
    domain: domainVerified ? domainName : null,
    domainVerified,
    verifiedAt: text(businessVerification?.verifiedAt) ?? (domainVerified ? text(domainStatus?.verifiedAt) : null),
  }

  if (containsEmail(safePayload)) {
    return { ok: false, reason: 'email-present' }
  }

  const keyState = asRecord(record.keyState)
  const activeKey = asRecord(keyState?.active)
  const keyStatus = activeKey ? 'active' : keyState ? 'revoked' : 'unknown'

  return {
    ok: true,
    agent: {
      ...safePayload,
      did: text(record.did) ?? `did:beam:${beamId}`,
      registerCourt: null,
      keyStatus,
    },
  }
}

export function projectPublicDirectory(payload: unknown): PublicAgentView[] {
  const record = asRecord(payload)
  const agents = Array.isArray(record?.agents) ? record.agents : []
  return agents.flatMap((agent) => {
    const projected = projectPublicAgent(agent)
    if (!projected.ok || !projected.agent.verified) {
      return []
    }
    return [projected.agent]
  })
}

export async function fingerprintPublicKey(publicKey: string): Promise<string> {
  const bytes = Uint8Array.from(publicKey, (char) => char.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 32).replace(/(.{4})/g, '$1 ').trim()
}

export function sealSnippet(origin: string, apiBase: string, beamId: string): { svgUrl: string; html: string } {
  const encoded = encodeURIComponent(beamId)
  const profileUrl = `${origin}/agents/${encoded}`
  const svgUrl = `${apiBase}/agents/${encoded}/seal.svg`
  const html = `<a href="${profileUrl}"><img alt="Beam Siegel" src="${svgUrl}" width="360" height="96" /></a>`
  return { svgUrl, html }
}
