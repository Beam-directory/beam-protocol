declare module 'nodemailer' {
  export interface TransportOptions {
    host?: string
    port?: number
    secure?: boolean
    auth?: {
      user?: string
      pass?: string
    }
  }

  export interface SendMailOptions {
    from?: string
    to: string
    subject: string
    text: string
    html: string
  }

  export interface Transporter {
    sendMail(message: SendMailOptions): Promise<unknown>
  }

  export function createTransport(options: TransportOptions): Transporter

  const nodemailer: {
    createTransport(options: TransportOptions): Transporter
  }

  export default nodemailer
}
