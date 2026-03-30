import type { AgentKeyRow, AgentRow } from '../types.js'
import { toBeamDID } from '../did.js'

export function serializeAgentKey(row: AgentKeyRow): object {
  return {
    id: row.id,
    beamId: row.beam_id,
    publicKey: row.public_key,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    status: row.revoked_at === null ? 'active' : 'revoked',
  }
}

export function serializeAgentKeyState(rows: AgentKeyRow[]): object {
  const active = rows.find((row) => row.revoked_at === null) ?? null
  return {
    active: active ? serializeAgentKey(active) : null,
    revoked: rows.filter((row) => row.revoked_at !== null).map(serializeAgentKey),
    keys: rows.map(serializeAgentKey),
    total: rows.length,
  }
}

export function serializeAgent(
  row: AgentRow,
  options: { connected?: boolean; keys?: AgentKeyRow[] } = {},
): object {
  const { email_token: _emailToken, api_key_hash: _apiKeyHash, ...agent } = row

  return {
    ...agent,
    did: toBeamDID(row.beam_id),
    capabilities: JSON.parse(row.capabilities) as string[],
    email_verified: row.email_verified === 1,
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
    ...(options.connected === undefined ? {} : { connected: options.connected }),
    ...(options.keys ? { keyState: serializeAgentKeyState(options.keys) } : {}),
  }
}
