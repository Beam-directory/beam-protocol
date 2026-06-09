import dns from 'node:dns/promises'
import https from 'node:https'
import { dashboardPackageVersion, optionalFlag, validateDashboardShellHtml } from './shared.mjs'
import { pathToFileURL } from 'node:url'

function numericFlag(name, fallback) {
  const raw = optionalFlag(name, String(fallback))
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/u, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchResolvedIp(url, ip, requestTimeoutMs = 15_000) {
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
        'User-Agent': 'beam-dashboard-shell-check/1.0',
      },
    }, (response) => {
      const chunks = []
      response.setEncoding('utf8')
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url,
          text: async () => chunks.join(''),
        })
      })
    })

    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(Object.assign(new Error(`Dashboard resolved-IP request timed out after ${requestTimeoutMs}ms`), { code: 'ETIMEDOUT' }))
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

async function fetchDashboardShell(url, { fetchImpl = fetch, dnsImpl = dns, fetchResolvedImpl = fetchResolvedIp } = {}) {
  let response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    if (isResolverMiss(error)) {
      try {
        const hostname = new URL(url).hostname
        const ips = await dnsImpl.resolve4(hostname)
        if (ips[0]) {
          response = await fetchResolvedImpl(url, ips[0])
        }
      } catch {
        // Preserve the original resolver failure below; the public-DNS fallback is best effort.
      }
    }

    if (!response) {
      const cause = error?.cause
      const code = cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN'
      const hostname = cause?.hostname ? ` (${cause.hostname})` : ''
      throw new Error(`Dashboard base URL is not reachable: ${url} [${code}]${hostname}`, { cause: error })
    }
  }

  const text = await response.text()
  if (!response.ok) {
    const title = extractTitle(text)
    throw new Error(`Dashboard base URL returned HTTP ${response.status}; expected the Beam Control Plane shell at ${response.url}${title ? ` (title: ${title})` : ''}`)
  }

  return { response, text }
}

function extractTitle(html) {
  return html.match(/<title>([^<]+)<\/title>/iu)?.[1] ?? null
}

export async function waitForDashboardShell(url, { timeoutMs, intervalMs, expectedDashboardVersion = dashboardPackageVersion, fetchImpl = fetch, dnsImpl = dns, fetchResolvedImpl = fetchResolvedIp, sleepImpl = sleep }) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastError = null

  do {
    attempts += 1
    try {
      const dashboard = await fetchDashboardShell(url, { fetchImpl, dnsImpl, fetchResolvedImpl })
      const validation = validateDashboardShellHtml(dashboard.text, expectedDashboardVersion)

      if (!validation.shellReady) {
        const versionHint = validation.versionReady
          ? ''
          : ` (version: ${validation.dashboardVersion ?? 'missing'} !== ${validation.expectedDashboardVersion})`
        throw new Error(`Dashboard base URL did not return the Beam Control Plane shell: ${dashboard.response.url}${validation.title ? ` (title: ${validation.title})` : ''}${versionHint}`)
      }

      return { ...dashboard, attempts, validation }
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline || intervalMs === 0) {
        break
      }
      await sleepImpl(intervalMs)
    }
  } while (Date.now() <= deadline)

  throw new Error(`Dashboard shell did not become ready after ${attempts} attempt${attempts === 1 ? '' : 's'} over ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`, {
    cause: lastError,
  })
}

async function main() {
  const dashboardBase = normalizeBaseUrl(optionalFlag('--dashboard-base', 'https://dashboard.beam.directory'))
  const timeoutMs = numericFlag('--timeout-ms', 15_000)
  const intervalMs = numericFlag('--interval-ms', 1_000)
  const expectedDashboardVersion = optionalFlag('--expected-dashboard-version', dashboardPackageVersion)
  const dashboard = await waitForDashboardShell(`${dashboardBase}/`, { timeoutMs, intervalMs, expectedDashboardVersion })

  console.log(JSON.stringify({
    ok: true,
    dashboardBase,
    url: dashboard.response.url,
    status: dashboard.response.status,
    attempts: dashboard.attempts,
    dashboardVersion: dashboard.validation.dashboardVersion,
    expectedDashboardVersion: dashboard.validation.expectedDashboardVersion,
    dashboardShellReady: true,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:dashboard-shell] failed:', error)
    process.exit(1)
  })
}
