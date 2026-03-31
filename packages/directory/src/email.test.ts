import assert from 'node:assert/strict'
import test from 'node:test'
import { getSmtpConfig, isEmailDeliveryConfigured } from './email.js'

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

test('getSmtpConfig prefers SMTP_PASS but falls back to SMTP_PASSWORD', () => {
  const snapshot = {
    SMTP_HOST: process.env['SMTP_HOST'],
    SMTP_PORT: process.env['SMTP_PORT'],
    SMTP_USER: process.env['SMTP_USER'],
    SMTP_PASS: process.env['SMTP_PASS'],
    SMTP_PASSWORD: process.env['SMTP_PASSWORD'],
    SMTP_FROM: process.env['SMTP_FROM'],
  }

  try {
    process.env['SMTP_HOST'] = 'smtp.example.com'
    process.env['SMTP_PORT'] = '587'
    process.env['SMTP_USER'] = 'beam@example.com'
    process.env['SMTP_FROM'] = 'Beam <beam@example.com>'
    delete process.env['SMTP_PASS']
    process.env['SMTP_PASSWORD'] = 'fallback-secret'

    const fallbackConfig = getSmtpConfig()
    assert.equal(fallbackConfig.host, 'smtp.example.com')
    assert.equal(fallbackConfig.pass, 'fallback-secret')
    assert.equal(fallbackConfig.secure, false)
    assert.equal(isEmailDeliveryConfigured(), true)

    process.env['SMTP_PASS'] = 'preferred-secret'
    const preferredConfig = getSmtpConfig()
    assert.equal(preferredConfig.pass, 'preferred-secret')

    process.env['SMTP_PORT'] = '465'
    const secureConfig = getSmtpConfig()
    assert.equal(secureConfig.secure, true)
  } finally {
    restoreEnv(snapshot)
  }
})
