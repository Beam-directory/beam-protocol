type MailTransport = {
  sendMail(message: {
    from?: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

export type SmtpConfig = {
  host: string | null
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  from: string | null
}

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

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(getSmtpConfig().host || process.env['RESEND_API_KEY'])
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

  if (getSmtpConfig().host) {
    const transporter = await createTransport()
    await transporter.sendMail(message)
    return true
  }

  if (process.env['RESEND_API_KEY']) {
    await sendWithResend(message)
    return true
  }

  console.warn('Email verification disabled: set SMTP_HOST or RESEND_API_KEY to enable delivery')
  return false
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

  if (getSmtpConfig().host) {
    const transporter = await createTransport()
    await transporter.sendMail(message)
    return true
  }

  if (process.env['RESEND_API_KEY']) {
    await sendWithResend(message)
    return true
  }

  console.warn('Admin email delivery disabled: set SMTP_HOST or RESEND_API_KEY to enable delivery')
  return false
}
