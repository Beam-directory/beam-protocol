import type { Database } from 'better-sqlite3'
import { getAdminSessionFromRequest, roleSatisfies } from './admin-auth.js'
import { agentApiKeyMatches, beamIdFromApiKey, getSuppliedApiKey, hashApiKey } from './api-key.js'
import { getOrgByApiKeyHash } from './db.js'
import type { AgentRow } from './types.js'

/**
 * Same caller scopes as GET /agents/managed:
 * directory admin, organization API key, agent API key, or a session whose
 * email matches a verified agent address.
 */
export function canReadNonPublicAgent(db: Database, request: Request, agent: AgentRow): boolean {
  const adminSession = getAdminSessionFromRequest(db, request)
  if (adminSession && roleSatisfies(adminSession.role, 'admin')) {
    return true
  }

  const suppliedKey = getSuppliedApiKey(request)
  if (suppliedKey.startsWith('beam_org_')) {
    const org = getOrgByApiKeyHash(db, hashApiKey(suppliedKey))
    if (org && agent.org === org.name) {
      return true
    }
  }

  if (suppliedKey.startsWith('bk_')) {
    const beamId = beamIdFromApiKey(suppliedKey)
    if (beamId === agent.beam_id && agentApiKeyMatches(agent, suppliedKey)) {
      return true
    }
  }

  if (
    adminSession
    && agent.email_verified === 1
    && typeof agent.email === 'string'
    && adminSession.email.trim().toLowerCase() === agent.email.trim().toLowerCase()
  ) {
    return true
  }

  return false
}

export function isPublicAgent(agent: AgentRow): boolean {
  return agent.visibility === 'public'
}
