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
  <rect width="360" height="96" rx="6" fill="#f7f8fa" stroke="#1b3a5f" stroke-width="1"/>
  <rect x="16" y="16" width="64" height="64" rx="4" fill="#1b3a5f"/>
  <path d="M36 48 l8 8 18-20" fill="none" stroke="#f7f8fa" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="96" y="36" font-family="Georgia, Palatino, serif" font-size="13" fill="#1b3a5f">Beam Register</text>
  <text x="96" y="58" font-family="Georgia, Palatino, serif" font-size="16" font-weight="600" fill="#1b2430">${name}</text>
  <text x="96" y="78" font-family="Georgia, Palatino, serif" font-size="12" fill="#3d4c63">${org} · ${tier}</text>
</svg>`
}
