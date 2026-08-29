import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getMicrosoftGraphConfig,
  getSmtpConfig,
  isEmailDeliveryConfigured,
  sendIdentityClaimEmail,
} from './email.js'

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

test('Microsoft Graph email delivery requires a complete dedicated app configuration', () => {
  const snapshot = {
    SMTP_HOST: process.env['SMTP_HOST'],
    RESEND_API_KEY: process.env['RESEND_API_KEY'],
    M365_TENANT_ID: process.env['M365_TENANT_ID'],
    M365_CLIENT_ID: process.env['M365_CLIENT_ID'],
    M365_CLIENT_SECRET: process.env['M365_CLIENT_SECRET'],
    M365_SENDER: process.env['M365_SENDER'],
    M365_REPLY_TO: process.env['M365_REPLY_TO'],
  }

  try {
    delete process.env['SMTP_HOST']
    delete process.env['RESEND_API_KEY']
    process.env['M365_TENANT_ID'] = 'tenant-id'
    process.env['M365_CLIENT_ID'] = 'client-id'
    process.env['M365_CLIENT_SECRET'] = 'client-secret'
    delete process.env['M365_SENDER']
    process.env['M365_REPLY_TO'] = 'team@beam.directory'

    assert.equal(isEmailDeliveryConfigured(), false)

    process.env['M365_SENDER'] = 'claim@beam.directory'
    assert.deepEqual(getMicrosoftGraphConfig(), {
      tenantId: 'tenant-id',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sender: 'claim@beam.directory',
      replyTo: 'team@beam.directory',
    })
    assert.equal(isEmailDeliveryConfigured(), true)
  } finally {
    restoreEnv(snapshot)
  }
})

test('Microsoft Graph delivery uses the dedicated sender and Beam reply-to address', async () => {
  const snapshot = {
    SMTP_HOST: process.env['SMTP_HOST'],
    RESEND_API_KEY: process.env['RESEND_API_KEY'],
    M365_TENANT_ID: process.env['M365_TENANT_ID'],
    M365_CLIENT_ID: process.env['M365_CLIENT_ID'],
    M365_CLIENT_SECRET: process.env['M365_CLIENT_SECRET'],
    M365_SENDER: process.env['M365_SENDER'],
    M365_REPLY_TO: process.env['M365_REPLY_TO'],
  }
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []

  try {
    delete process.env['SMTP_HOST']
    delete process.env['RESEND_API_KEY']
    process.env['M365_TENANT_ID'] = 'tenant-id'
    process.env['M365_CLIENT_ID'] = 'client-id'
    process.env['M365_CLIENT_SECRET'] = 'client-secret'
    process.env['M365_SENDER'] = 'claim@beam.directory'
    process.env['M365_REPLY_TO'] = 'team@beam.directory'

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      requests.push({ url, init })
      if (url.includes('/oauth2/v2.0/token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 60 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(null, { status: 202 })
    }

    const delivered = await sendIdentityClaimEmail({
      email: 'owner@example.com',
      displayName: 'Owner',
      beamId: 'owner@beam.directory',
      url: 'https://beam.directory/claim#token=test',
    })

    assert.equal(delivered, true)
    assert.equal(requests.length, 2)
    assert.match(requests[0]!.url, /login\.microsoftonline\.com\/tenant-id\/oauth2\/v2\.0\/token$/)
    assert.equal(
      requests[1]!.url,
      'https://graph.microsoft.com/v1.0/users/claim%40beam.directory/sendMail',
    )
    assert.equal(requests[1]!.init?.headers && (requests[1]!.init.headers as Record<string, string>).Authorization, 'Bearer test-token')

    const payload = JSON.parse(String(requests[1]!.init?.body)) as {
      message: {
        body: { contentType: string }
        replyTo: Array<{ emailAddress: { address: string } }>
        toRecipients: Array<{ emailAddress: { address: string } }>
      }
    }
    assert.equal(payload.message.body.contentType, 'HTML')
    assert.equal(payload.message.replyTo[0]?.emailAddress.address, 'team@beam.directory')
    assert.equal(payload.message.toRecipients[0]?.emailAddress.address, 'owner@example.com')
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv(snapshot)
  }
})
