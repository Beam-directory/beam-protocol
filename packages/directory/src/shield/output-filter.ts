/**
 * Beam Shield — Wall 4: Output Filter
 * Detects PII, credentials, and sensitive data in agent responses before sending.
 */

export const PII_PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone_de: /(?<!\d)\+?49[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,}[\s.-]?\d{0,}/g,
  phone_intl: /(?<!\d)\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,}/g,
  iban: /[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,4}/g,
  credit_card: /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
  api_key: /(?:sk_live|sk_test|pk_live|pk_test|api[_-]?key|bearer|token|secret)[_\s:=-]*[a-zA-Z0-9_-]{20,}/gi,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  ipv4_internal: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
  german_tax_id: /\b\d{2}\/\d{3}\/\d{5}\b/g,
  password_in_url: /(?:password|passwd|pwd)=[^&\s]{4,}/gi,
}

export interface PIIMatch {
  type: string
  value: string
  index: number
}

export function detectPII(text: string): { found: boolean; matches: PIIMatch[] } {
  const matches: PIIMatch[] = []

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    // Reset regex state for global patterns
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      matches.push({ type, value: match[0], index: match.index })
    }
  }

  return { found: matches.length > 0, matches }
}

export function detectCredentials(text: string): { found: boolean; types: string[] } {
  const types: string[] = []

  if (/sk_(?:live|test)_[a-zA-Z0-9]{20,}/i.test(text)) types.push('stripe_secret_key')
  if (/pk_(?:live|test)_[a-zA-Z0-9]{20,}/i.test(text)) types.push('stripe_publishable_key')
  if (/whsec_[a-zA-Z0-9]{20,}/i.test(text)) types.push('stripe_webhook_secret')
  if (/ghp_[a-zA-Z0-9]{36}/i.test(text)) types.push('github_pat')
  if (/gho_[a-zA-Z0-9]{36}/i.test(text)) types.push('github_oauth')
  if (/xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/i.test(text)) types.push('slack_bot_token')
  if (/xoxp-[0-9]+-[0-9]+-[a-zA-Z0-9]+/i.test(text)) types.push('slack_user_token')
  if (/AKIA[0-9A-Z]{16}/i.test(text)) types.push('aws_access_key')
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i.test(text)) types.push('private_key_pem')
  if (PII_PATTERNS.jwt.test(text)) types.push('jwt_token')
  if (/Bearer\s+[a-zA-Z0-9_-]{20,}/i.test(text)) types.push('bearer_token')

  return { found: types.length > 0, types }
}

export function redactPII(text: string): string {
  let redacted = text

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const re = new RegExp(pattern.source, pattern.flags)
    redacted = redacted.replace(re, `[REDACTED-${type}]`)
  }

  return redacted
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface OutputRiskAssessment {
  riskLevel: RiskLevel
  reasons: string[]
  shouldBlock: boolean
  piiCount: number
  credentialCount: number
}

export function assessOutputRisk(
  text: string,
  recipientTrust: number,
): OutputRiskAssessment {
  const pii = detectPII(text)
  const creds = detectCredentials(text)
  const reasons: string[] = []

  if (pii.found) {
    const types = [...new Set(pii.matches.map((m) => m.type))]
    reasons.push(`PII detected: ${types.join(', ')}`)
  }

  if (creds.found) {
    reasons.push(`Credentials detected: ${creds.types.join(', ')}`)
  }

  if (text.length > 2048 && recipientTrust < 0.5) {
    reasons.push('Large response to low-trust recipient')
  }

  // Risk scoring
  let riskLevel: RiskLevel = 'low'
  let shouldBlock = false

  if (creds.found) {
    riskLevel = 'critical'
    shouldBlock = true
  } else if (pii.matches.length >= 3 && recipientTrust < 0.6) {
    riskLevel = 'high'
    shouldBlock = true
  } else if (pii.found && recipientTrust < 0.3) {
    riskLevel = 'high'
    shouldBlock = true
  } else if (pii.found) {
    riskLevel = 'medium'
  }

  return {
    riskLevel,
    reasons,
    shouldBlock,
    piiCount: pii.matches.length,
    credentialCount: creds.types.length,
  }
}

export interface OutputFilterContext {
  recipientBeamId: string
  recipientTrust: number
  recipientTier: string
}

export interface OutputFilterResult {
  allowed: boolean
  original: string
  filtered: string
  redactedItems: string[]
  riskLevel: RiskLevel
  reasons: string[]
}

export function filterOutput(response: string, context: OutputFilterContext): OutputFilterResult {
  const risk = assessOutputRisk(response, context.recipientTrust)
  const pii = detectPII(response)
  const redactedItems = pii.matches.map((m) => `${m.type}: ${m.value.slice(0, 4)}...`)

  if (risk.shouldBlock) {
    return {
      allowed: false,
      original: response,
      filtered: 'I cannot share that information.',
      redactedItems,
      riskLevel: risk.riskLevel,
      reasons: risk.reasons,
    }
  }

  // For medium risk: redact PII but allow the response
  const filtered = risk.riskLevel === 'medium' ? redactPII(response) : response

  return {
    allowed: true,
    original: response,
    filtered,
    redactedItems: risk.riskLevel === 'medium' ? redactedItems : [],
    riskLevel: risk.riskLevel,
    reasons: risk.reasons,
  }
}
