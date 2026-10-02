import { describe, expect, it } from 'vitest'
import { DRAFT_PRICING, formatEuro, pricingLines } from './pricing'

describe('draft pricing', () => {
  it('keeps the October 2026 draft figures in one constant', () => {
    expect(DRAFT_PRICING.draft).toBe(true)
    expect(DRAFT_PRICING.companyReviewEur).toBe(149)
    expect(DRAFT_PRICING.monthlyEur).toBe(39)
    expect(DRAFT_PRICING.includedAgents).toBe(2)
    expect(DRAFT_PRICING.extraAgentMonthlyEur).toBe(9)
    expect(DRAFT_PRICING.directoryIncluded).toBe(true)
    expect(DRAFT_PRICING.verificationFree).toBe(true)
    expect(DRAFT_PRICING.pilotEur).toBe(290)
    expect(DRAFT_PRICING.pilotDays).toBe(90)
  })

  it('formats the public price lines in German', () => {
    expect(formatEuro(149).replace(/\s/g, ' ')).toBe('149 €')
    const lines = pricingLines()
    expect(lines[0]).toContain('149')
    expect(lines[1]).toContain('39')
    expect(lines[2]).toContain('9')
    expect(lines).toContain('Verzeichniseintrag inklusive')
    expect(lines).toContain('Prüfen für Empfänger kostenlos')
    expect(lines.at(-1)).toContain('290')
    expect(lines.at(-1)).toContain('90')
  })
})
