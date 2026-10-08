const DE_REGISTRATION_RE = /^(HRB|HRA)[\s-]*(\d{1,12})$/i
const APPLICANT_ROLES = new Set([
  'geschaeftsfuehrer',
  'vorstand',
  'prokurist',
  'inhaber',
  'director',
  'authorized_signatory',
])

export type RegistryKind = 'handelsregister' | 'lei'

export type RegistryClaim = {
  kind: RegistryKind
  country: string
  registrationNumber: string
  registerCourt: string | null
  legalName: string
  applicantName: string
  applicantRole: string
}

export function normalizeApplicantRole(value: string): string | null {
  const normalized = value.trim().toLowerCase().replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('ß', 'ss').replace(/[\s_-]+/g, '')
  const aliases: Record<string, string> = {
    geschaeftsfuehrer: 'geschaeftsfuehrer',
    vorstand: 'vorstand',
    prokurist: 'prokurist',
    inhaber: 'inhaber',
    director: 'director',
    authorizedsignatory: 'authorized_signatory',
  }
  const role = aliases[normalized] ?? null
  return role && APPLICANT_ROLES.has(role) ? role : null
}

export function normalizeGermanRegistration(value: string): string | null {
  const match = DE_REGISTRATION_RE.exec(value.trim().toUpperCase())
  if (!match?.[1] || !match[2]) {
    return null
  }
  return `${match[1]} ${match[2]}`
}

export function isValidLei(value: string): boolean {
  const lei = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{20}$/.test(lei)) {
    return false
  }
  let expanded = ''
  for (const char of lei) {
    const code = char.charCodeAt(0)
    expanded += code >= 65 ? String(code - 55) : char
  }
  let remainder = 0
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

export function parseRegistryClaim(raw: Record<string, unknown>): { claim: RegistryClaim } | { error: string } {
  const kind = raw['kind'] === 'lei' ? 'lei' : raw['kind'] === 'handelsregister' ? 'handelsregister' : null
  if (!kind) {
    return { error: 'kind must be handelsregister or lei' }
  }
  const country = typeof raw['country'] === 'string' ? raw['country'].trim().toUpperCase() : ''
  const legalName = typeof raw['legalName'] === 'string' ? raw['legalName'].trim() : ''
  const applicantName = typeof raw['applicantName'] === 'string' ? raw['applicantName'].trim() : ''
  const applicantRole = typeof raw['applicantRole'] === 'string' ? normalizeApplicantRole(raw['applicantRole']) : null
  const registerCourt = typeof raw['registerCourt'] === 'string' && raw['registerCourt'].trim()
    ? raw['registerCourt'].trim()
    : null
  if (!/^[A-Z]{2}$/.test(country) || legalName.length < 2 || legalName.length > 200 || applicantName.length < 2 || !applicantRole) {
    return { error: 'country, legalName, applicantName and a representation role are required' }
  }

  if (kind === 'handelsregister') {
    if (country !== 'DE') {
      return { error: 'handelsregister filings are currently accepted for DE only' }
    }
    const registrationNumber = typeof raw['registrationNumber'] === 'string'
      ? normalizeGermanRegistration(raw['registrationNumber'])
      : null
    if (!registrationNumber || !registerCourt || registerCourt.length > 160) {
      return { error: 'German filings need an HRB or HRA number and the register court' }
    }
    return {
      claim: { kind, country, registrationNumber, registerCourt, legalName, applicantName, applicantRole },
    }
  }

  const lei = typeof raw['registrationNumber'] === 'string' ? raw['registrationNumber'].trim().toUpperCase() : ''
  if (!isValidLei(lei)) {
    return { error: 'registrationNumber must be a checksum-valid LEI' }
  }
  return {
    claim: { kind, country, registrationNumber: lei, registerCourt: null, legalName, applicantName, applicantRole },
  }
}
