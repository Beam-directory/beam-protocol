import { describe, expect, it } from 'vitest'
import { de } from '../i18n/de.ts'
import { en } from '../i18n/en.ts'
import { describeActions } from './plain-actions.ts'

describe('describeActions', () => {
  it('uses plain words in both languages', () => {
    expect(describeActions(['read', 'file.send'], null, en.check.actions)).toBe('read, send files')
    expect(describeActions(['read', 'file.send'], null, de.check.actions)).toBe('lesen, Dateien senden')
  })

  it('names the order limit and keeps unknown actions as they are', () => {
    const order = { maxAmount: '500.00', currency: 'EUR' }
    expect(describeActions(['order', 'schedule.commit', 'x.custom'], order, de.check.actions)).toBe('bestellen bis 500.00 EUR, Termine zusagen, x.custom')
  })
})
