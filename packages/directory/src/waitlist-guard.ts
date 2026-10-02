import type { Database } from 'better-sqlite3'

export const SEAL_APPLICATION_SOURCE = 'seal-application'
export const SEAL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000
export const WAITLIST_HONEYPOT_FIELD = 'hp_company'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

const LIMITS = {
  email: 254,
  company: 200,
  source: 80,
  contactName: 120,
  workflowSummary: 4000,
  genericWorkflowSummary: 8000,
  sealAgentCountMax: 500,
  genericAgentCountMax: 100_000,
} as const

export interface WaitlistGuardInput {
  email: string
  company: string | null
  agentCount: number | null
  source: string | null
  workflowType: string | null
  workflowSummary: string | null
  domain: string | null
  contactName: string | null
}

export interface WaitlistGuardError {
  error: string
  errorCode: string
}

export function isSealApplication(source: string | null, workflowType: string | null): boolean {
  return source === SEAL_APPLICATION_SOURCE || workflowType === SEAL_APPLICATION_SOURCE
}

export function isWaitlistHoneypotTripped(raw: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(raw, WAITLIST_HONEYPOT_FIELD)) {
    return false
  }

  const value = raw[WAITLIST_HONEYPOT_FIELD]
  if (value == null) {
    return false
  }
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  return true
}

function cleanLine(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null
  }
  return trimmed
}

export function readOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null
  }
  return trimmed
}

function labeledValue(summary: string | null, label: string): string | null {
  if (!summary) return null
  const match = new RegExp(`^${label}:\\s*(.+)$`, 'im').exec(summary)
  return match?.[1]?.trim() ?? null
}

export function resolveSealDomain(domain: string | null, workflowSummary: string | null): string | null {
  return cleanLine(domain)?.toLowerCase() ?? cleanLine(labeledValue(workflowSummary, 'Domain'))?.toLowerCase() ?? null
}

export function resolveSealContact(contactName: string | null, workflowSummary: string | null): string | null {
  return cleanLine(contactName) ?? cleanLine(labeledValue(workflowSummary, 'Kontakt'))
}

export function validateWaitlistSubmission(input: WaitlistGuardInput): WaitlistGuardError | null {
  const seal = isSealApplication(input.source, input.workflowType)

  if (input.email.length > LIMITS.email || (seal && !EMAIL_RE.test(input.email))) {
    return { error: 'A valid email is required', errorCode: 'INVALID_EMAIL' }
  }

  if (input.source && input.source.length > LIMITS.source) {
    return { error: 'source is too long', errorCode: 'INVALID_SOURCE' }
  }
  if (input.workflowType && input.workflowType.length > LIMITS.source) {
    return { error: 'workflowType is too long', errorCode: 'INVALID_WORKFLOW_TYPE' }
  }

  const summaryLimit = seal ? LIMITS.workflowSummary : LIMITS.genericWorkflowSummary
  if (input.workflowSummary && input.workflowSummary.length > summaryLimit) {
    return { error: 'workflowSummary is too long', errorCode: 'INVALID_WORKFLOW_SUMMARY' }
  }

  if (input.company && (input.company.length > LIMITS.company || /[\u0000-\u001f\u007f]/.test(input.company))) {
    return { error: 'company is invalid', errorCode: 'INVALID_COMPANY' }
  }

  const agentCountMax = seal ? LIMITS.sealAgentCountMax : LIMITS.genericAgentCountMax
  if (input.agentCount !== null && input.agentCount > agentCountMax) {
    return { error: 'agentCount is too large', errorCode: 'INVALID_AGENT_COUNT' }
  }

  if (!seal) {
    return null
  }

  if (input.source !== SEAL_APPLICATION_SOURCE || input.workflowType !== SEAL_APPLICATION_SOURCE) {
    return { error: 'Seal applications must use the seal-application source', errorCode: 'INVALID_SOURCE' }
  }
  if (!input.company || input.company.trim().length < 2) {
    return { error: 'company is required', errorCode: 'INVALID_COMPANY' }
  }
  if (input.agentCount === null || input.agentCount < 1) {
    return { error: 'agentCount must be between 1 and 500', errorCode: 'INVALID_AGENT_COUNT' }
  }

  const domain = resolveSealDomain(input.domain, input.workflowSummary)
  if (!domain || !DOMAIN_RE.test(domain)) {
    return { error: 'domain must be a valid DNS hostname', errorCode: 'INVALID_DOMAIN' }
  }

  const contactName = resolveSealContact(input.contactName, input.workflowSummary)
  if (!contactName || contactName.length < 2 || contactName.length > LIMITS.contactName) {
    return { error: 'contactName is required', errorCode: 'INVALID_CONTACT' }
  }

  return null
}

export function findRecentSealApplication(
  db: Database,
  email: string,
  company: string,
  nowMs = Date.now(),
): { id: number } | undefined {
  const cutoff = new Date(nowMs - SEAL_DEDUPE_WINDOW_MS).toISOString()
  return db.prepare(`
    SELECT id
    FROM waitlist
    WHERE lower(email) = lower(?)
      AND lower(company) = lower(?)
      AND (source = ? OR workflow_type = ?)
      AND created_at >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(email, company, SEAL_APPLICATION_SOURCE, SEAL_APPLICATION_SOURCE, cutoff) as { id: number } | undefined
}
