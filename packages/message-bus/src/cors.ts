import type { Hono } from 'hono'
import { cors } from 'hono/cors'

const DEFAULT_PUBLIC_CORS_ORIGINS = new Set([
  'https://beam.directory',
  'https://www.beam.directory',
  'https://dashboard.beam.directory',
  'https://beam-dashboard.vercel.app',
])

function getConfiguredOrigins(): Set<string> {
  const configured = process.env['BEAM_BUS_ALLOWED_ORIGINS']
  if (!configured) {
    return DEFAULT_PUBLIC_CORS_ORIGINS
  }

  return new Set(
    configured
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

export function resolveBusCorsOrigin(origin?: string | null): string | null {
  if (!origin) {
    return null
  }

  if (getConfiguredOrigins().has(origin)) {
    return origin
  }

  try {
    const parsed = new URL(origin)
    const isLoopbackHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isLoopbackHost && isHttp) {
      return origin
    }
  } catch {
    return null
  }

  return null
}

export function applyBusCors(app: Hono): void {
  app.use('*', cors({
    origin: (origin) => resolveBusCorsOrigin(origin) ?? '',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))
}
