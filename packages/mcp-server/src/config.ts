import { BeamClient, BeamIdentity, type BeamIdString, type VerificationTier } from 'beam-protocol-sdk'
import { requiredSecret } from './secret-file.js'
import { assertX25519KeyPair } from './network-crypto.js'

const DEFAULT_DIRECTORY_URL = 'https://api.beam.directory'

export interface BeamMcpConfig {
  beamId: BeamIdString
  publicKeyBase64: string
  privateKeyBase64: string
  dhPublicKeyBase64?: string
  dhPrivateKeyBase64?: string
  apiKey: string
  directoryUrl: string
  allowedIntents: ReadonlySet<string>
  requireVerifiedTarget: boolean
  minimumVerificationTier: VerificationTier
  minimumTrustScore: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function parseDirectoryUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('BEAM_DIRECTORY_URL must be a valid URL')
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new Error('BEAM_DIRECTORY_URL must use HTTPS (HTTP is allowed only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('BEAM_DIRECTORY_URL must not contain credentials, query parameters, or fragments')
  }

  return url.toString().replace(/\/$/, '')
}

function parseAllowedIntents(raw: string | undefined): ReadonlySet<string> {
  const configured = (raw ?? 'conversation.message')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (configured.length === 0) {
    throw new Error('BEAM_MCP_ALLOWED_INTENTS must contain at least one intent')
  }
  for (const intent of configured) {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(intent)) {
      throw new Error('BEAM_MCP_ALLOWED_INTENTS contains an invalid intent name')
    }
  }
  return new Set(configured)
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  if (raw.trim().toLowerCase() === 'true') return true
  if (raw.trim().toLowerCase() === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function parseTrustScore(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0.5
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('BEAM_MCP_MIN_TRUST_SCORE must be a number between 0 and 1')
  }
  return value
}

function parseVerificationTier(raw: string | undefined, fallback: VerificationTier): VerificationTier {
  const value = raw?.trim().toLowerCase() || fallback
  if (value === 'basic' || value === 'verified' || value === 'business' || value === 'enterprise') {
    return value
  }
  throw new Error('BEAM_MCP_MIN_VERIFICATION_TIER must be basic, verified, business, or enterprise')
}

export function loadBeamMcpConfig(env: NodeJS.ProcessEnv = process.env): BeamMcpConfig {
  const beamId = required(env, 'BEAM_ID')
  if (!BeamIdentity.parseBeamId(beamId)) {
    throw new Error('BEAM_ID must be a valid Beam ID')
  }

  const requireVerifiedTarget = parseBoolean(
    env['BEAM_MCP_REQUIRE_VERIFIED_TARGET'],
    true,
    'BEAM_MCP_REQUIRE_VERIFIED_TARGET',
  )
  const hasDhPublic = Boolean(env['BEAM_DH_PUBLIC_KEY_BASE64']?.trim() || env['BEAM_DH_PUBLIC_KEY_BASE64_FILE']?.trim())
  const hasDhPrivate = Boolean(env['BEAM_DH_PRIVATE_KEY_BASE64']?.trim() || env['BEAM_DH_PRIVATE_KEY_BASE64_FILE']?.trim())
  if (hasDhPublic !== hasDhPrivate) throw new Error('Set both BEAM_DH_PUBLIC_KEY_BASE64 and BEAM_DH_PRIVATE_KEY_BASE64 secrets')
  const config: BeamMcpConfig = {
    beamId: beamId as BeamIdString,
    publicKeyBase64: requiredSecret(env, 'BEAM_PUBLIC_KEY_BASE64'),
    privateKeyBase64: requiredSecret(env, 'BEAM_PRIVATE_KEY_BASE64'),
    ...(hasDhPublic ? {
      dhPublicKeyBase64: requiredSecret(env, 'BEAM_DH_PUBLIC_KEY_BASE64'),
      dhPrivateKeyBase64: requiredSecret(env, 'BEAM_DH_PRIVATE_KEY_BASE64'),
    } : {}),
    apiKey: requiredSecret(env, 'BEAM_API_KEY'),
    directoryUrl: parseDirectoryUrl(env['BEAM_DIRECTORY_URL']?.trim() || DEFAULT_DIRECTORY_URL),
    allowedIntents: parseAllowedIntents(env['BEAM_MCP_ALLOWED_INTENTS']),
    requireVerifiedTarget,
    minimumVerificationTier: parseVerificationTier(
      env['BEAM_MCP_MIN_VERIFICATION_TIER'],
      requireVerifiedTarget ? 'verified' : 'basic',
    ),
    minimumTrustScore: parseTrustScore(env['BEAM_MCP_MIN_TRUST_SCORE']),
  }

  // Fail fast if either DER key is invalid or the public key does not match the private identity.
  const identity = BeamIdentity.fromData({
    beamId: config.beamId,
    publicKeyBase64: config.publicKeyBase64,
    privateKeyBase64: config.privateKeyBase64,
  })
  const keyProbe = 'beam-mcp-key-pair-check-v1'
  if (!BeamIdentity.verify(keyProbe, identity.sign(keyProbe), config.publicKeyBase64)) {
    throw new Error('BEAM public and private key material do not match')
  }
  if (config.dhPublicKeyBase64 && config.dhPrivateKeyBase64) {
    assertX25519KeyPair(config.dhPublicKeyBase64, config.dhPrivateKeyBase64)
  }

  return config
}

export function createBeamClient(config: BeamMcpConfig): BeamClient {
  return new BeamClient({
    identity: {
      beamId: config.beamId,
      publicKeyBase64: config.publicKeyBase64,
      privateKeyBase64: config.privateKeyBase64,
    },
    apiKey: config.apiKey,
    directoryUrl: config.directoryUrl,
  })
}
