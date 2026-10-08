import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

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

const blockedAddresses = new BlockList()
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
blockedAddresses.addSubnet('192.0.0.0', 24, 'ipv4')
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('198.18.0.0', 15, 'ipv4')
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4')
blockedAddresses.addSubnet('240.0.0.0', 4, 'ipv4')
blockedAddresses.addAddress('::', 'ipv6')
blockedAddresses.addAddress('::1', 'ipv6')
blockedAddresses.addSubnet('64:ff9b::', 96, 'ipv6')
blockedAddresses.addSubnet('2002::', 16, 'ipv6')
blockedAddresses.addSubnet('fc00::', 7, 'ipv6')
blockedAddresses.addSubnet('fe80::', 10, 'ipv6')
blockedAddresses.addSubnet('fec0::', 10, 'ipv6')
blockedAddresses.addSubnet('ff00::', 8, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    return !blockedAddresses.check(address, 'ipv4')
  }
  if (version !== 6) {
    return false
  }
  const embedded = embeddedIpv4(address)
  if (embedded) {
    return isPublicAddress(embedded)
  }
  return !blockedAddresses.check(address, 'ipv6')
}

function embeddedIpv4(address: string): string | null {
  const words = ipv6Words(address)
  if (!words) {
    return null
  }
  const [a, b, c, d, e, f, g, h] = words
  if (a !== 0 || b !== 0 || c !== 0 || d !== 0 || e !== 0) {
    return null
  }
  if (f === 0xffff) {
    return ipv4FromWords(g ?? 0, h ?? 0)
  }
  if (f === 0 && !((g ?? 0) === 0 && (h ?? 0) <= 1)) {
    return ipv4FromWords(g ?? 0, h ?? 0)
  }
  return null
}

function ipv4FromWords(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function ipv6Words(address: string): number[] | null {
  let input = address.toLowerCase()
  const dotted = input.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map((part) => Number(part))
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255)) {
      return null
    }
    const [o1, o2, o3, o4] = octets as [number, number, number, number]
    input = `${dotted[1]}${((o1 << 8) | o2).toString(16)}:${((o3 << 8) | o4).toString(16)}`
  }
  const pieces = input.split('::')
  if (pieces.length > 2) {
    return null
  }
  const head = pieces[0] ? pieces[0].split(':') : []
  const tail = pieces.length === 2 ? (pieces[1] ? pieces[1].split(':') : []) : []
  if (pieces.length === 1 && head.length !== 8) {
    return null
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) {
    return null
  }
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null
  }
  return groups.map((group) => Number.parseInt(group, 16))
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
