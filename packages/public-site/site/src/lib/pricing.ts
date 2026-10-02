/**
 * Draft commercial terms from the October 2026 registry plan.
 * Change this object to update every public price on the site.
 */
export const DRAFT_PRICING = {
  draft: true,
  notice: 'Entwurfspreise',
  companyReviewEur: 149,
  monthlyEur: 39,
  includedAgents: 2,
  extraAgentMonthlyEur: 9,
  directoryIncluded: true,
  verificationFree: true,
  pilotEur: 290,
  pilotDays: 90,
} as const

const euro = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

export function formatEuro(amount: number): string {
  return euro.format(amount)
}

export function pricingLines(pricing: typeof DRAFT_PRICING = DRAFT_PRICING): string[] {
  return [
    `Firmenprüfung einmalig ${formatEuro(pricing.companyReviewEur)}`,
    `${formatEuro(pricing.monthlyEur)} pro Monat inklusive ${pricing.includedAgents} Agenten`,
    `${formatEuro(pricing.extraAgentMonthlyEur)} je weiterem Agenten und Monat`,
    pricing.directoryIncluded ? 'Verzeichniseintrag inklusive' : 'Verzeichniseintrag optional',
    pricing.verificationFree ? 'Prüfen für Empfänger kostenlos' : 'Prüfen kostenpflichtig',
    `Pilot ${formatEuro(pricing.pilotEur)} für ${pricing.pilotDays} Tage`,
  ]
}
