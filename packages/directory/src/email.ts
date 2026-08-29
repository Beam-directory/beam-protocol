type MailTransport = {
  sendMail(message: {
    from?: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

type EmailMessage = {
  from?: string
  to: string
  subject: string
  text: string
  html: string
}

export type SmtpConfig = {
  host: string | null
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  from: string | null
}

export type MicrosoftGraphConfig = {
  tenantId: string | null
  clientId: string | null
  clientSecret: string | null
  sender: string | null
  replyTo: string | null
}

type CachedGraphToken = {
  accessToken: string
  expiresAt: number
}

let cachedGraphToken: CachedGraphToken | null = null

export function getSmtpConfig(): SmtpConfig {
  const host = process.env['SMTP_HOST']?.trim() || null
  const port = Number(process.env['SMTP_PORT'] ?? '587')
  const user = process.env['SMTP_USER']?.trim() || null
  const pass = process.env['SMTP_PASS']?.trim() || process.env['SMTP_PASSWORD']?.trim() || null
  const from = process.env['SMTP_FROM']?.trim() || null

  return {
    host,
    port,
    secure: port === 465,
    user,
    pass,
    from,
  }
}

export function getMicrosoftGraphConfig(): MicrosoftGraphConfig {
  return {
    tenantId: process.env['M365_TENANT_ID']?.trim() || null,
    clientId: process.env['M365_CLIENT_ID']?.trim() || null,
    clientSecret: process.env['M365_CLIENT_SECRET']?.trim() || null,
    sender: process.env['M365_SENDER']?.trim() || null,
    replyTo: process.env['M365_REPLY_TO']?.trim() || null,
  }
}

function isMicrosoftGraphConfigured(config = getMicrosoftGraphConfig()): boolean {
  return Boolean(config.tenantId && config.clientId && config.clientSecret && config.sender)
}

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(
    getSmtpConfig().host
    || isMicrosoftGraphConfigured()
    || process.env['RESEND_API_KEY'],
  )
}

async function createTransport(): Promise<MailTransport> {
  const nodemailerModule = await import('nodemailer')
  const nodemailer = 'default' in nodemailerModule ? nodemailerModule.default : nodemailerModule
  const smtp = getSmtpConfig()

  return nodemailer.createTransport({
    host: smtp.host ?? undefined,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user || smtp.pass
      ? {
          user: smtp.user ?? undefined,
          pass: smtp.pass ?? undefined,
        }
      : undefined,
  })
}

async function sendWithResend(message: {
  from?: string
  to: string
  subject: string
  text: string
  html: string
}): Promise<void> {
  const apiKey = process.env['RESEND_API_KEY']
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured')
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`Resend email request failed with status ${response.status}${details ? `: ${details}` : ''}`)
  }
}

async function acquireMicrosoftGraphToken(config: MicrosoftGraphConfig, forceRefresh = false): Promise<string> {
  if (!isMicrosoftGraphConfigured(config)) {
    throw new Error('Microsoft Graph email delivery is not fully configured')
  }

  if (!forceRefresh && cachedGraphToken && cachedGraphToken.expiresAt > Date.now() + 60_000) {
    return cachedGraphToken.accessToken
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId!)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(15_000),
    },
  )

  if (!response.ok) {
    throw new Error(`Microsoft Graph token request failed with status ${response.status}`)
  }

  const payload = await response.json() as { access_token?: string; expires_in?: number }
  if (!payload.access_token) {
    throw new Error('Microsoft Graph token response did not contain an access token')
  }

  cachedGraphToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
  }
  return payload.access_token
}

async function sendWithMicrosoftGraph(message: EmailMessage): Promise<void> {
  const config = getMicrosoftGraphConfig()
  if (!isMicrosoftGraphConfigured(config)) {
    throw new Error('Microsoft Graph email delivery is not fully configured')
  }

  const send = async (forceRefresh = false): Promise<Response> => {
    const accessToken = await acquireMicrosoftGraphToken(config, forceRefresh)
    return fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.sender!)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: {
              contentType: 'HTML',
              content: message.html,
            },
            toRecipients: [{ emailAddress: { address: message.to } }],
            ...(config.replyTo
              ? { replyTo: [{ emailAddress: { address: config.replyTo } }] }
              : {}),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )
  }

  let response = await send()
  if (response.status === 401) {
    cachedGraphToken = null
    response = await send(true)
  }

  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 2_000)
    throw new Error(
      `Microsoft Graph email request failed with status ${response.status}${details ? `: ${details}` : ''}`,
    )
  }
}

async function sendEmailMessage(
  message: EmailMessage,
  disabledWarning: string,
): Promise<boolean> {
  if (getSmtpConfig().host) {
    const transporter = await createTransport()
    await transporter.sendMail(message)
    return true
  }

  if (isMicrosoftGraphConfigured()) {
    await sendWithMicrosoftGraph(message)
    return true
  }

  if (process.env['RESEND_API_KEY']) {
    await sendWithResend(message)
    return true
  }

  console.warn(disabledWarning)
  return false
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export async function sendIdentityClaimEmail(input: {
  email: string
  displayName: string
  beamId: string
  url: string
}): Promise<boolean> {
  const safeName = escapeHtml(input.displayName)
  const safeBeamId = escapeHtml(input.beamId)
  const safeUrl = escapeHtml(input.url)
  const message = {
    from: getSmtpConfig().from ?? undefined,
    to: input.email,
    subject: `Claim ${input.beamId}`,
    text: `Hi ${input.displayName}, confirm this email address to claim ${input.beamId}: ${input.url}\n\nThis link expires in 30 minutes. If you did not request it, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Confirm this email address to claim <strong>${safeBeamId}</strong>.</p><p><a href="${safeUrl}">Claim your Beam</a></p><p>This link expires in 30 minutes. If you did not request it, you can ignore this email.</p>`,
  }

  return sendEmailMessage(
    message,
    'Identity claim delivery disabled: set SMTP_HOST, Microsoft Graph, or RESEND_API_KEY to enable delivery',
  )
}

export async function sendAgentVerificationEmail(input: {
  email: string
  beamId: string
  token: string
}): Promise<boolean> {
  const verificationUrl = new URL('/agents/verify-email', process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3100')
  verificationUrl.searchParams.set('token', input.token)

  const message = {
    from: getSmtpConfig().from ?? undefined,
    to: input.email,
    subject: `Verify your Beam Directory email for ${input.beamId}`,
    text: `Verify your Beam Directory email for ${input.beamId}: ${verificationUrl.toString()}`,
    html: `<p>Verify your Beam Directory email for <strong>${input.beamId}</strong>.</p><p><a href="${verificationUrl.toString()}">Verify email</a></p>`,
  }

  return sendEmailMessage(
    message,
    'Email verification disabled: set SMTP_HOST, Microsoft Graph, or RESEND_API_KEY to enable delivery',
  )
}

export async function sendAdminMagicLinkEmail(input: {
  email: string
  url: string
  role: 'admin' | 'operator' | 'viewer'
}): Promise<boolean> {
  const message = {
    from: getSmtpConfig().from ?? undefined,
    to: input.email,
    subject: 'Beam admin sign-in link',
    text: `Use this Beam admin sign-in link to continue as ${input.role}: ${input.url}`,
    html: `<p>Use this Beam admin sign-in link to continue as <strong>${input.role}</strong>.</p><p><a href="${input.url}">Sign in to Beam Dashboard</a></p>`,
  }

  return sendEmailMessage(
    message,
    'Admin email delivery disabled: set SMTP_HOST, Microsoft Graph, or RESEND_API_KEY to enable delivery',
  )
}

export async function sendOperatorDigestEmail(input: {
  email: string
  subject: string
  markdown: string
}): Promise<boolean> {
  const html = input.markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`)
    .join('')

  return sendEmailMessage(
    {
      from: getSmtpConfig().from ?? undefined,
      to: input.email,
      subject: input.subject,
      text: input.markdown,
      html,
    },
    'Operator digest delivery disabled: set SMTP_HOST, Microsoft Graph, or RESEND_API_KEY to enable delivery',
  )
}
