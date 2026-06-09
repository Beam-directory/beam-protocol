import dns from 'node:dns/promises'
import https from 'node:https'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { dashboardPackageVersion, formatDate, formatDateTime, optionalFlag, toJsonBlock, validateDashboardShellHtml, writeMarkdownReport } from './shared.mjs'

export function createDashboardDomainConfig({ argv = process.argv, env = process.env } = {}) {
  const optional = (name, fallback = null) => {
    if (argv === process.argv) {
      return optionalFlag(name, fallback)
    }

    const index = argv.indexOf(name)
    if (index === -1) {
      return fallback
    }

    const value = argv[index + 1] ?? fallback
    if (typeof value !== 'string') {
      return value
    }

    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.startsWith('--')) {
      return fallback
    }

    return trimmed
  }
  const hasFlag = (name) => argv.includes(name)

  const dashboardDomain = optional('--domain', 'dashboard.beam.directory')
  const dashboardBase = optional('--dashboard-base', `https://${dashboardDomain}`)
  const expectedRecordType = normalizeRecordType(optional('--record-type', hasFlag('--expected-cname') ? 'CNAME' : 'A'))
  const expectedRecordValue = normalizeDnsValue(optional(
    '--record-value',
    expectedRecordType === 'CNAME'
      ? optional('--expected-cname', 'cname.vercel-dns.com')
      : optional('--expected-a', '76.76.21.21'),
  ))
  const expectedCname = expectedRecordType === 'CNAME'
    ? expectedRecordValue
    : normalizeDnsValue(optional('--expected-cname', 'cname.vercel-dns.com'))
  const expectedA = expectedRecordType === 'A'
    ? expectedRecordValue
    : normalizeDnsValue(optional('--expected-a', '76.76.21.21'))
  const godaddyZone = optional('--godaddy-zone', 'beam.directory')

  return {
    dashboardDomain,
    dashboardBase,
    expectedRecordType,
    expectedRecordValue,
    expectedCname,
    expectedA,
    expectedDashboardVersion: optional('--expected-dashboard-version', dashboardPackageVersion),
    godaddyZone,
    godaddyRecord: optional('--godaddy-record', dashboardDomain.replace(new RegExp(`\\.${escapeRegExp(godaddyZone)}$`, 'u'), '')),
    godaddyEnvPath: optional('--godaddy-env', env.GODADDY_ENV ?? null),
    requestTimeoutMs: numericValue('--request-timeout-ms', optional('--request-timeout-ms', '15000'), 1),
    timeoutMs: numericValue('--timeout-ms', optional('--timeout-ms', '0'), 0),
    intervalMs: numericValue('--interval-ms', optional('--interval-ms', '1000'), 0),
    outputPath: optional('--output'),
  }
}

function normalizeRecordType(value) {
  const type = String(value).trim().toUpperCase()
  if (type !== 'A' && type !== 'CNAME') {
    throw new Error(`Invalid --record-type value: ${value}`)
  }
  return type
}

function numericValue(name, raw, min) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function normalizeDnsValue(value) {
  return String(value).trim().replace(/\.$/u, '').toLowerCase()
}

function publicDnsError(error) {
  const code = error?.code ?? error?.name ?? 'UNKNOWN'
  if (code === 'ENODATA' || code === 'ENOTFOUND') {
    return { code, message: error.message }
  }
  return { code, message: error?.message ?? 'Unknown DNS error' }
}

export async function resolvePublicDns(config, dependencies = {}) {
  const dnsApi = dependencies.dns ?? dns
  const [cname, a, aaaa] = await Promise.all([
    dnsApi.resolveCname(config.dashboardDomain).then((records) => ({ records })).catch((error) => ({ records: [], error: publicDnsError(error) })),
    dnsApi.resolve4(config.dashboardDomain).then((records) => ({ records })).catch((error) => ({ records: [], error: publicDnsError(error) })),
    dnsApi.resolve6(config.dashboardDomain).then((records) => ({ records })).catch((error) => ({ records: [], error: publicDnsError(error) })),
  ])

  const normalizedCname = cname.records.map(normalizeDnsValue)
  const normalizedA = a.records.map(normalizeDnsValue)
  const expectedCnamePresent = normalizedCname.includes(config.expectedCname)
  const expectedARecordPresent = normalizedA.includes(config.expectedA)
  return {
    cname: cname.records,
    a: a.records,
    aaaa: aaaa.records,
    errors: {
      cname: cname.error ?? null,
      a: a.error ?? null,
      aaaa: aaaa.error ?? null,
    },
    expectedCnamePresent,
    expectedARecordPresent,
    expectedRecordPresent: config.expectedRecordType === 'CNAME' ? expectedCnamePresent : expectedARecordPresent,
  }
}

export async function loadGoDaddyCredentials(config, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const readFileImpl = dependencies.readFile ?? readFile
  const fromEnv = {
    apiKey: env.GODADDY_API_KEY ?? null,
    apiSecret: env.GODADDY_API_SECRET ?? null,
    source: 'environment',
  }
  if (fromEnv.apiKey && fromEnv.apiSecret) {
    return fromEnv
  }

  if (!config.godaddyEnvPath) {
    return null
  }

  const envText = await readFileImpl(config.godaddyEnvPath, 'utf8')
  const credentials = {
    apiKey: null,
    apiSecret: null,
    source: config.godaddyEnvPath,
  }

  for (const line of envText.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?(GODADDY_API_KEY|GODADDY_API_SECRET)\s*=\s*(.*)\s*$/u)
    if (!match) {
      continue
    }
    const [, name, rawValue] = match
    const value = rawValue.trim().replace(/^['"]|['"]$/gu, '')
    if (name === 'GODADDY_API_KEY') {
      credentials.apiKey = value
    }
    if (name === 'GODADDY_API_SECRET') {
      credentials.apiSecret = value
    }
  }

  return credentials.apiKey && credentials.apiSecret ? credentials : null
}

async function fetchText(config, url, init = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  const text = await response.text()
  return { response, text }
}

async function fetchTextWithResolvedIp(config, url, ip, dependencies = {}) {
  const fetchResolvedImpl = dependencies.fetchResolved ?? fetchTextViaResolvedIp
  return fetchResolvedImpl(config, url, ip)
}

async function fetchTextViaResolvedIp(config, url, ip) {
  const target = new URL(url)
  if (target.protocol !== 'https:') {
    throw new Error(`Resolved-IP dashboard fallback only supports https URLs: ${url}`)
  }

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: ip,
      port: target.port || 443,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      headers: {
        Host: target.host,
        'User-Agent': 'beam-production-preflight/1.0',
      },
    }, (response) => {
      const chunks = []
      response.setEncoding('utf8')
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          response: {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            url,
            headers: response.headers,
          },
          text: chunks.join(''),
        })
      })
    })

    request.setTimeout(config.requestTimeoutMs, () => {
      request.destroy(Object.assign(new Error(`Dashboard resolved-IP request timed out after ${config.requestTimeoutMs}ms`), { code: 'ETIMEDOUT' }))
    })
    request.on('error', reject)
    request.end()
  })
}

function isResolverMiss(error) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? error?.name
  return code === 'ENOTFOUND' || code === 'ENODATA'
}

export async function fetchDashboardShell(config, dependencies = {}) {
  const url = `${String(config.dashboardBase).replace(/\/+$/u, '')}/`
  try {
    const { response, text } = await fetchText(config, url, {}, dependencies)
    const validation = validateDashboardShellHtml(text, config.expectedDashboardVersion)
    return {
      reachable: true,
      status: response.status,
      url: response.url,
      title: validation.title,
      dashboardVersion: validation.dashboardVersion,
      expectedDashboardVersion: validation.expectedDashboardVersion,
      versionReady: validation.versionReady,
      shellReady: response.ok && validation.shellReady,
    }
  } catch (error) {
    if (isResolverMiss(error)) {
      try {
        const publicDns = await resolvePublicDns(config, dependencies)
        const ip = publicDns.a.find((record) => normalizeDnsValue(record) === config.expectedA) ?? publicDns.a[0] ?? null
        if (ip) {
          const { response, text } = await fetchTextWithResolvedIp(config, url, ip, dependencies)
          const validation = validateDashboardShellHtml(text, config.expectedDashboardVersion)
          return {
            reachable: true,
            status: response.status,
            url: response.url,
            resolvedIp: ip,
            resolvedViaPublicDns: true,
            title: validation.title,
            dashboardVersion: validation.dashboardVersion,
            expectedDashboardVersion: validation.expectedDashboardVersion,
            versionReady: validation.versionReady,
            shellReady: response.ok && validation.shellReady,
          }
        }
      } catch {
        // Preserve the original resolver failure below; the public-DNS fallback is best effort.
      }
    }
    const cause = error?.cause
    return {
      reachable: false,
      status: null,
      url,
      title: null,
      shellReady: false,
      error: {
        code: cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN',
        message: error?.message ?? 'Unknown fetch error',
        hostname: cause?.hostname ?? null,
      },
    }
  }
}

async function requestGoDaddyRecord(config, credentials, type, dependencies = {}) {
  const url = `https://api.godaddy.com/v1/domains/${encodeURIComponent(config.godaddyZone)}/records/${type}/${encodeURIComponent(config.godaddyRecord)}`
  const { response, text } = await fetchText(config, url, {
    headers: {
      Authorization: `sso-key ${credentials.apiKey}:${credentials.apiSecret}`,
    },
  }, dependencies)

  if (!response.ok) {
    throw new Error(`GoDaddy ${type} lookup failed with HTTP ${response.status}: ${text.slice(0, 240)}`)
  }

  const records = JSON.parse(text)
  return records.map(({ data, name, ttl }) => ({
    type,
    name,
    data,
    ttl,
  }))
}

export async function inspectGoDaddy(config, dependencies = {}) {
  const credentials = await loadGoDaddyCredentials(config, dependencies)
  if (!credentials) {
    return {
      checked: false,
      zone: config.godaddyZone,
      record: config.godaddyRecord,
      reason: 'GODADDY_API_KEY and GODADDY_API_SECRET not available',
    }
  }

  try {
    const [cname, a, aaaa] = await Promise.all([
      requestGoDaddyRecord(config, credentials, 'CNAME', dependencies),
      requestGoDaddyRecord(config, credentials, 'A', dependencies),
      requestGoDaddyRecord(config, credentials, 'AAAA', dependencies),
    ])
    return {
      checked: true,
      zone: config.godaddyZone,
      record: config.godaddyRecord,
      credentialSource: credentials.source === 'environment' ? 'environment' : 'env-file',
      cname,
      a,
      aaaa,
      expectedCnamePresent: cname.map((record) => normalizeDnsValue(record.data)).includes(config.expectedCname),
      expectedARecordPresent: a.map((record) => normalizeDnsValue(record.data)).includes(config.expectedA),
      expectedRecordPresent: config.expectedRecordType === 'CNAME'
        ? cname.map((record) => normalizeDnsValue(record.data)).includes(config.expectedCname)
        : a.map((record) => normalizeDnsValue(record.data)).includes(config.expectedA),
    }
  } catch (error) {
    return {
      checked: true,
      zone: config.godaddyZone,
      record: config.godaddyRecord,
      error: error?.message ?? 'Unknown GoDaddy API error',
      expectedCnamePresent: false,
      expectedARecordPresent: false,
      expectedRecordPresent: false,
    }
  }
}

async function runDashboardDomainPreflightAttempt(config, dependencies = {}) {
  const [publicDns, godaddy, dashboard] = await Promise.all([
    resolvePublicDns(config, dependencies),
    inspectGoDaddy(config, dependencies),
    fetchDashboardShell(config, dependencies),
  ])

  const ok = publicDns.expectedRecordPresent
    && dashboard.shellReady
    && (!godaddy.checked || godaddy.expectedRecordPresent)

  const result = {
    ok,
    date: formatDate(),
    generatedAt: formatDateTime(),
    dashboardDomain: config.dashboardDomain,
    dashboardBase: config.dashboardBase,
    expectedRecordType: config.expectedRecordType,
    expectedRecordValue: config.expectedRecordValue,
    expectedCname: config.expectedCname,
    expectedA: config.expectedA,
    expectedDashboardVersion: config.expectedDashboardVersion,
    requestTimeoutMs: config.requestTimeoutMs,
    timeoutMs: config.timeoutMs,
    intervalMs: config.intervalMs,
    publicDns,
    godaddy,
    dashboard,
  }
  return result
}

export async function runDashboardDomainPreflight(config = createDashboardDomainConfig(), dependencies = {}) {
  const sleepImpl = dependencies.sleep ?? sleep
  const startedAt = Date.now()
  const deadline = startedAt + config.timeoutMs
  let attempts = 0
  let result

  do {
    attempts += 1
    result = await runDashboardDomainPreflightAttempt(config, dependencies)
    result.attempts = attempts
    result.elapsedMs = Date.now() - startedAt
    if (result.ok || config.intervalMs === 0 || Date.now() >= deadline) {
      return result
    }
    await sleepImpl(Math.min(config.intervalMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)

  return result
}

async function main() {
  const config = createDashboardDomainConfig()
  const result = await runDashboardDomainPreflight(config)

  if (config.outputPath) {
    const markdown = `# Beam Dashboard Domain Preflight

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- dashboard domain: \`${config.dashboardDomain}\`
- dashboard base: \`${config.dashboardBase}\`
- expected DNS record: \`${config.expectedRecordType} ${config.godaddyRecord} ${config.expectedRecordValue}\`
- expected dashboard version: \`${config.expectedDashboardVersion}\`
- GoDaddy zone: \`${config.godaddyZone}\`
- GoDaddy record: \`${config.godaddyRecord}\`
- request timeout: \`${config.requestTimeoutMs}ms\`
- overall timeout: \`${config.timeoutMs}ms\`
- retry interval: \`${config.intervalMs}ms\`

## Result

\`${result.ok ? 'PASS' : 'FAIL'}\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(path.resolve(config.outputPath), markdown)
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:dashboard-domain] failed:', error)
    process.exitCode = 1
  })
}
