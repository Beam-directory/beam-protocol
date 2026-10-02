import { describe, expect, it } from 'vitest'
import { buildSealApplicationPayload, validateSealApplication } from './seal-application'

const valid = {
  companyName: 'COPPEN GmbH',
  contactName: 'Ada Operator',
  email: 'Ada@Coppen.example',
  domain: 'coppen.example',
  agentCount: 3,
  message: 'Bitte den Piloten vorbereiten.',
}

describe('seal application', () => {
  it('builds a waitlist payload without payment or mail delivery fields', () => {
    const payload = buildSealApplicationPayload(valid)
    expect(payload).toMatchObject({
      email: 'ada@coppen.example',
      company: 'COPPEN GmbH',
      agentCount: 3,
      source: 'seal-application',
      workflowType: 'seal-application',
    })
    expect(payload.workflowSummary).toContain('Zahlung: nicht ausgelöst')
    expect(payload.workflowSummary).toContain('E-Mail-Versand: nicht ausgelöst')
    expect(payload.workflowSummary).toContain('coppen.example')
    expect(payload.domain).toBe('coppen.example')
    expect(payload.contactName).toBe('Ada Operator')
    expect(payload.hp_company).toBe('')
    expect(JSON.stringify(payload)).not.toContain('stripe')
    expect(JSON.stringify(payload)).not.toContain('card')
  })

  it('rejects an incomplete application before any request is sent', () => {
    expect(validateSealApplication({ ...valid, email: 'not-an-email' })).toMatch(/E-Mail/)
    expect(validateSealApplication({ ...valid, domain: 'localhost' })).toMatch(/Domain/)
    expect(validateSealApplication(valid)).toBeNull()
  })
})
