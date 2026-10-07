import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'

const WELL_KNOWN_PATH = '/.well-known/beam-verification'
const MAX_BODY_BYTES = 4096

export function verificationRecord(token: string): string {
  return `beam-verification=${token}`
}

export function wellKnownUrl(domain: string): string {
  return `https://${domain}${WELL_KNOWN_PATH}`
}

export function bodyContainsVerification(body: string, token: string): boolean {
  const expected = verificationRecord(token)
  return body.split(/\r?\n/).some((line) => line.trim() === expected)
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    return isPublicIpv4(address)
  }
  if (version === 6) {
    const lower = address.toLowerCase()
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped?.[1]) {
      return isPublicIpv4(mapped[1])
    }
    if (lower === '::1' || lower === '::') {
      return false
    }
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return false
    }
    return true
  }
  return false
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a >= 224) return false
  return true
}

export async function fetchWellKnownVerification(domain: string): Promise<string> {
  if (isIP(domain) !== 0) {
    throw new Error('DOMAIN_NOT_PUBLIC')
  }
  const records = await lookup(domain, { all: true, verbatim: true })
  if (records.length === 0 || records.some((record) => !isPublicAddress(record.address))) {
    throw new Error('DOMAIN_NOT_PUBLIC')
  }
  const pinned = records[0]
  if (!pinned) {
    throw new Error('DOMAIN_NOT_PUBLIC')
  }

  return await new Promise((resolve, reject) => {
    const request = https.request({
      host: domain,
      servername: domain,
      path: WELL_KNOWN_PATH,
      method: 'GET',
      timeout: 5_000,
      headers: { accept: 'text/plain' },
      lookup: (_hostname, _options, callback) => {
        callback(null, pinned.address, pinned.family)
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('WELL_KNOWN_HTTP'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          request.destroy(new Error('WELL_KNOWN_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('WELL_KNOWN_TIMEOUT')))
    request.end()
  })
}
