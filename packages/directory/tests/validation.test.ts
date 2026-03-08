import { describe, expect, it } from 'vitest'
import { knownIntentTypes, validateIntentPayload } from '../src/validation.js'

const validPayloads: Record<string, Record<string, unknown>> = {
  'agent.introduce': { question: 'Who are you?' },
  'agent.ping': { message: 'Still alive?' },
  'escalation.request': {
    caseId: 'CASE-123',
    reason: 'Need supervisor approval',
    urgency: 'high',
    customerName: 'Jane Doe',
  },
  'payment.status_check': {
    projectId: 'PROJ-7',
    invoiceNumber: 'INV-44',
    customerName: 'Acme Corp',
  },
  'sales.pipeline_summary': { timeRange: '30d', owner: 'clara' },
  'system.broadcast': { message: 'Scheduled maintenance', priority: 'warning' },
  'task.delegate': {
    task: 'Compile quarterly report',
    context: 'Finance closing process',
    deadline: '2026-03-10',
    priority: 'medium',
  },
}

const wrongTypePayloads: Record<string, Record<string, unknown>> = {
  'agent.introduce': { question: 123 },
  'agent.ping': { message: 123 },
  'escalation.request': { caseId: 123, reason: 'Need help' },
  'payment.status_check': { projectId: 123 },
  'sales.pipeline_summary': { timeRange: 30 },
  'system.broadcast': { message: 123 },
  'task.delegate': { task: 42 },
}

describe('validation', () => {
  it('covers every catalog intent currently defined', () => {
    expect(knownIntentTypes()).toEqual(Object.keys(validPayloads).sort())
  })

  for (const [intentType, payload] of Object.entries(validPayloads)) {
    it(`accepts valid payloads for ${intentType}`, () => {
      expect(validateIntentPayload(intentType, payload)).toEqual({ valid: true })
    })
  }

  it('rejects missing required fields for intents that require them', () => {
    expect(validateIntentPayload('escalation.request', { caseId: 'CASE-1' })).toEqual({
      valid: false,
      error: 'Invalid payload for intent escalation.request at /: must have required property \'reason\'',
    })
    expect(validateIntentPayload('system.broadcast', {})).toEqual({
      valid: false,
      error: 'Invalid payload for intent system.broadcast at /: must have required property \'message\'',
    })
    expect(validateIntentPayload('task.delegate', { context: 'No task provided' })).toEqual({
      valid: false,
      error: 'Invalid payload for intent task.delegate at /: must have required property \'task\'',
    })
  })

  for (const [intentType, payload] of Object.entries(wrongTypePayloads)) {
    it(`rejects wrong field types for ${intentType}`, () => {
      const result = validateIntentPayload(intentType, payload)
      expect(result.valid).toBe(false)
      expect(result.error).toContain(`Invalid payload for intent ${intentType}`)
    })
  }

  it('rejects unknown intents', () => {
    expect(validateIntentPayload('unknown.intent', { anything: true })).toEqual({
      valid: false,
      error: 'Unknown intent type: unknown.intent',
    })
  })
})
