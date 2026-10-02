import type { AgentRow } from './types.js'

const VERIFIED_TIERS = new Set(['verified', 'business', 'enterprise'])

export function isPublicCompanyAgent(row: AgentRow): boolean {
  return row.visibility === 'public' && row.personal === 0 && row.flagged === 0 && Boolean(row.org)
}

export function isVerifiedPublicCompanyAgent(row: AgentRow): boolean {
  if (!isPublicCompanyAgent(row)) {
    return false
  }
  return row.verified === 1 || VERIFIED_TIERS.has(row.verification_tier)
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

export function renderPublicSealSvg(row: AgentRow): string | null {
  if (!isVerifiedPublicCompanyAgent(row)) {
    return null
  }

  const org = escapeXml(row.org ?? '')
  const name = escapeXml(row.display_name)
  const tier = escapeXml(row.verification_tier)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-label="Beam Siegel">
  <rect width="360" height="96" rx="16" fill="#111111"/>
  <rect x="12" y="12" width="72" height="72" rx="12" fill="#f4f4f5"/>
  <text x="48" y="56" text-anchor="middle" font-family="Geist, ui-sans-serif, sans-serif" font-size="22" font-weight="700" fill="#111111">B</text>
  <text x="100" y="36" font-family="Geist, ui-sans-serif, sans-serif" font-size="13" fill="#a1a1aa">Beam · geprüft</text>
  <text x="100" y="58" font-family="Geist, ui-sans-serif, sans-serif" font-size="16" font-weight="600" fill="#fafafa">${name}</text>
  <text x="100" y="78" font-family="Geist, ui-sans-serif, sans-serif" font-size="12" fill="#d4d4d8">${org} · ${tier}</text>
</svg>`
}
