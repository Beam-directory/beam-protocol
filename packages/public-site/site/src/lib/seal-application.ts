import { DRAFT_PRICING } from './pricing'

export interface SealApplicationInput {
  companyName: string
  contactName: string
  email: string
  domain: string
  agentCount: number
  message: string
}

export interface SealApplicationPayload {
  email: string
  company: string
  agentCount: number
  contactName: string
  domain: string
  source: 'seal-application'
  workflowType: 'seal-application'
  workflowSummary: string
  hp_company: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export function validateSealApplication(input: SealApplicationInput): string | null {
  if (input.companyName.trim().length < 2) {
    return 'Bitte den Firmennamen angeben.'
  }
  if (input.contactName.trim().length < 2) {
    return 'Bitte eine Ansprechperson angeben.'
  }
  if (!EMAIL_RE.test(input.email.trim().toLowerCase())) {
    return 'Bitte eine gültige E-Mail-Adresse angeben.'
  }
  if (!DOMAIN_RE.test(input.domain.trim().toLowerCase())) {
    return 'Bitte eine gültige Domain angeben.'
  }
  if (!Number.isInteger(input.agentCount) || input.agentCount < 1 || input.agentCount > 500) {
    return 'Die Zahl der Agenten muss zwischen 1 und 500 liegen.'
  }
  if (input.message.trim().length > 2000) {
    return 'Die Nachricht ist zu lang.'
  }
  return null
}

export function buildSealApplicationPayload(input: SealApplicationInput, honeypot = ''): SealApplicationPayload {
  const summary = [
    `Kontakt: ${input.contactName.trim()}`,
    `Domain: ${input.domain.trim().toLowerCase()}`,
    `Entwurfspreise: ${DRAFT_PRICING.notice}`,
    `Pilot: ${DRAFT_PRICING.pilotEur} EUR / ${DRAFT_PRICING.pilotDays} Tage`,
    'Zahlung: nicht ausgelöst',
    'E-Mail-Versand: nicht ausgelöst',
    input.message.trim() ? `Nachricht: ${input.message.trim()}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n')

  return {
    email: input.email.trim().toLowerCase(),
    company: input.companyName.trim(),
    agentCount: input.agentCount,
    contactName: input.contactName.trim(),
    domain: input.domain.trim().toLowerCase(),
    source: 'seal-application',
    workflowType: 'seal-application',
    workflowSummary: summary,
    hp_company: honeypot,
  }
}
