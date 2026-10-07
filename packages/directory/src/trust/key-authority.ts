import { timingSafeEqual } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { hashApiKey, getSuppliedApiKey } from '../api-key.js'
import { verifyPayload } from '../crypto.js'
import { getOrg } from '../db.js'
import { getPerson } from './person-store.js'
import type { AgentRow } from '../types.js'

function hashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function orgKeyAuthorizes(db: Database, agent: AgentRow, request: Request): boolean {
  if (!agent.org) {
    return false
  }
  const org = getOrg(db, agent.org)
  const supplied = getSuppliedApiKey(request)
  if (!org || !supplied.startsWith('beam_org_')) {
    return false
  }
  return hashesMatch(hashApiKey(supplied), org.api_key_hash)
}

export function keyChangeAuthorized(
  db: Database,
  agent: AgentRow,
  request: Request,
  payload: Record<string, unknown>,
  signature?: string,
  legacyProof?: { newPublicKey: string; rotationProof?: string },
): boolean {
  if (signature?.trim() && verifyPayload(payload, signature.trim(), agent.public_key)) {
    return true
  }

  if (
    legacyProof?.rotationProof
    && legacyProof.newPublicKey
    && verifyPayload(legacyProof.newPublicKey, legacyProof.rotationProof, agent.public_key)
  ) {
    return true
  }

  return orgKeyAuthorizes(db, agent, request) || personKeyAuthorizes(db, agent, payload, signature)
}

function personKeyAuthorizes(
  db: Database,
  agent: AgentRow,
  payload: Record<string, unknown>,
  signature?: string,
): boolean {
  if (!signature?.trim() || !agent.responsible_person_id) {
    return false
  }
  const person = getPerson(db, agent.responsible_person_id)
  if (!person || person.status !== 'active' || person.org_name !== agent.org || !person.public_key) {
    return false
  }
  return verifyPayload(payload, signature.trim(), person.public_key)
}
