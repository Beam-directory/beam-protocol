type MailTransport = {
  sendMail(message: {
    from?: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

const REQUIRED_SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const

export function isEmailDeliveryConfigured(): boolean {
  return REQUIRED_SMTP_VARS.every((key) => Boolean(process.env[key]))
}

async function createTransport(): Promise<MailTransport> {
  const nodemailerModule = await import('nodemailer')
  const nodemailer = 'default' in nodemailerModule ? nodemailerModule.default : nodemailerModule
  return nodemailer.createTransport({
    host: process.env['SMTP_HOST'],
    port: Number(process.env['SMTP_PORT'] ?? '587'),
    secure: Number(process.env['SMTP_PORT'] ?? '587') === 465,
    auth: {
      user: process.env['SMTP_USER'],
      pass: process.env['SMTP_PASS'],
    },
  })
}

export async function sendAgentVerificationEmail(input: {
  email: string
  beamId: string
  token: string
}): Promise<boolean> {
  if (!isEmailDeliveryConfigured()) {
    return false
  }

  const transporter = await createTransport()
  const verificationUrl = new URL('/agents/verify', process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3100')
  verificationUrl.searchParams.set('token', input.token)

  await transporter.sendMail({
    from: process.env['SMTP_FROM'],
    to: input.email,
    subject: `Verify your Beam Directory email for ${input.beamId}`,
    text: `Verify your Beam Directory email for ${input.beamId}: ${verificationUrl.toString()}`,
    html: `<p>Verify your Beam Directory email for <strong>${input.beamId}</strong>.</p><p><a href="${verificationUrl.toString()}">Verify email</a></p>`,
  })

  return true
}
