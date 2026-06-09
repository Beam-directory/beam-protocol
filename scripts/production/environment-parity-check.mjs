import path from 'node:path'
import { dashboardPackageVersion, formatDate, formatDateTime, optionalFlag, toJsonBlock, validateDashboardShellHtml, writeMarkdownReport } from './shared.mjs'
import { createDashboardDomainConfig, runDashboardDomainPreflight } from './dashboard-domain-preflight.mjs'

const defaultDashboardDomain = 'dashboard.beam.directory'
const apiBase = optionalFlag('--api-base', 'https://api.beam.directory')
const siteBase = optionalFlag('--site-base', 'https://beam.directory')
const dashboardBase = optionalFlag('--dashboard-base', 'https://dashboard.beam.directory')
const docsUrl = optionalFlag('--docs-url', 'https://docs.beam.directory/guide/production-partner-workflow')
const dashboardDomain = optionalFlag('--dashboard-domain', defaultDashboardDomainFor(dashboardBase))
const dashboardDomainTimeoutMs = numericFlag('--dashboard-domain-timeout-ms', 0, 0)
const dashboardDomainIntervalMs = numericFlag('--dashboard-domain-interval-ms', 1_000, 0)
const godaddyEnvPath = optionalFlag('--godaddy-env', process.env.GODADDY_ENV ?? null)
const requestTimeoutMs = numericFlag('--request-timeout-ms', 15_000, 1)
const expectedDashboardVersion = optionalFlag('--expected-dashboard-version', dashboardPackageVersion)
const outputPath = optionalFlag('--output')

function numericFlag(name, fallback, min) {
  const raw = optionalFlag(name, String(fallback))
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function defaultDashboardDomainFor(value) {
  try {
    const hostname = new URL(value).hostname
    return hostname === defaultDashboardDomain ? defaultDashboardDomain : ''
  } catch {
    return ''
  }
}

function extractTitle(html) {
  return html.match(/<title>([^<]+)<\/title>/iu)?.[1] ?? null
}

async function fetchWithTimeout(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) })
    const text = await response.text()
    if (!response.ok) {
      const title = extractTitle(text)
      const httpError = new Error(`Request to ${url} failed with HTTP ${response.status}${title ? ` (title: ${title})` : ''}`)
      httpError.code = 'HTTP_STATUS'
      throw httpError
    }
    return {
      response,
      text,
    }
  } catch (error) {
    if (error?.code === 'HTTP_STATUS') {
      throw error
    }
    const cause = error?.cause
    const code = cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN'
    throw new Error(`Request to ${url} failed within ${requestTimeoutMs}ms [${code}]: ${error.message}`, { cause: error })
  }
}

async function requestJson(url) {
  const result = await fetchWithTimeout(url)
  try {
    return JSON.parse(result.text)
  } catch (error) {
    throw new Error(`Request to ${url} returned non-JSON content: ${result.text.slice(0, 240)}`, { cause: error })
  }
}

async function requestText(url) {
  return fetchWithTimeout(url)
}

function normalizeRelease(payload) {
  const release = payload && typeof payload === 'object' && payload.release && typeof payload.release === 'object'
    ? payload.release
    : payload
  if (!release || typeof release !== 'object') {
    return null
  }
  return {
    version: typeof release.version === 'string' ? release.version : null,
    gitSha: typeof release.gitSha === 'string' ? release.gitSha : null,
    deployedAt: typeof release.deployedAt === 'string' ? release.deployedAt : null,
  }
}

function summarizeDomainPreflight(preflight) {
  const expectedType = preflight.expectedRecordType ?? 'CNAME'
  const publicRecords = expectedType === 'A' ? preflight.publicDns.a : preflight.publicDns.cname
  const publicError = expectedType === 'A' ? preflight.publicDns.errors.a : preflight.publicDns.errors.cname
  const publicStatus = publicRecords.length > 0
    ? publicRecords.join(', ')
    : publicError?.code ?? 'missing'
  const godaddyRecords = expectedType === 'A' ? preflight.godaddy.a : preflight.godaddy.cname
  const godaddyStatus = preflight.godaddy.checked
    ? (godaddyRecords?.map((record) => record.data).join(', ') || preflight.godaddy.error || 'missing')
    : 'not checked'
  const dashboardStatus = preflight.dashboard.reachable
    ? `HTTP ${preflight.dashboard.status}${preflight.dashboard.title ? ` (${preflight.dashboard.title})` : ''}`
    : preflight.dashboard.error?.code ?? 'unreachable'
  return `public ${expectedType}=${publicStatus}; GoDaddy ${expectedType}=${godaddyStatus}; dashboard=${dashboardStatus}; attempts=${preflight.attempts ?? 1}`
}

async function runDashboardDomainGate() {
  if (!dashboardDomain) {
    return {
      checked: false,
      reason: 'dashboard domain preflight skipped for non-production dashboard base',
    }
  }

  const argv = [
    'node',
    'dashboard-domain-preflight.mjs',
    '--domain',
    dashboardDomain,
    '--dashboard-base',
    dashboardBase,
    '--request-timeout-ms',
    String(requestTimeoutMs),
    '--expected-dashboard-version',
    expectedDashboardVersion,
    '--timeout-ms',
    String(dashboardDomainTimeoutMs),
    '--interval-ms',
    String(dashboardDomainIntervalMs),
  ]
  if (godaddyEnvPath) {
    argv.push('--godaddy-env', godaddyEnvPath)
  }

  const config = createDashboardDomainConfig({ argv, env: process.env })
  const preflight = await runDashboardDomainPreflight(config)
  if (!preflight.ok) {
    throw new Error(`Dashboard production domain preflight failed: ${summarizeDomainPreflight(preflight)}`)
  }
  return {
    checked: true,
    ...preflight,
  }
}

async function main() {
  const [health, stats, release, statusPage, docs] = await Promise.all([
    requestJson(`${apiBase}/health`),
    requestJson(`${apiBase}/stats`),
    requestJson(`${apiBase}/release`),
    requestText(`${siteBase}/status.html`),
    requestText(docsUrl),
  ])
  const dashboardDomainPreflight = await runDashboardDomainGate()

  const normalizedHealth = normalizeRelease(health)
  const normalizedStats = normalizeRelease(stats)
  const normalizedRelease = normalizeRelease(release)
  const releaseTruthConsistent = JSON.stringify(normalizedHealth) === JSON.stringify(normalizedStats)
    && JSON.stringify(normalizedHealth) === JSON.stringify(normalizedRelease)

  if (!releaseTruthConsistent) {
    throw new Error('Release truth drift detected across /health, /stats, and /release.')
  }

  const statusMentionsApi = statusPage.text.includes(`${apiBase}/health`) && statusPage.text.includes(`${apiBase}/stats`)
  if (!statusMentionsApi) {
    throw new Error('Public status page does not reference the current API base URLs.')
  }

  const dashboardShell = dashboardDomainPreflight.checked && dashboardDomainPreflight.dashboard?.shellReady
    ? {
        title: dashboardDomainPreflight.dashboard.title,
        titleReady: dashboardDomainPreflight.dashboard.title === 'Beam Control Plane',
        rootReady: true,
        dashboardVersion: dashboardDomainPreflight.dashboard.dashboardVersion,
        expectedDashboardVersion: dashboardDomainPreflight.dashboard.expectedDashboardVersion,
        versionReady: dashboardDomainPreflight.dashboard.versionReady,
        shellReady: dashboardDomainPreflight.dashboard.shellReady,
      }
    : validateDashboardShellHtml((await requestText(`${dashboardBase}/`)).text, expectedDashboardVersion)
  if (!dashboardShell.shellReady) {
    throw new Error(`Dashboard base URL did not return the expected Beam Control Plane shell version: ${dashboardShell.dashboardVersion ?? 'missing'} !== ${dashboardShell.expectedDashboardVersion}.`)
  }

  const result = {
    ok: true,
    date: formatDate(),
    apiBase,
    siteBase,
    dashboardBase,
    docsUrl,
    requestTimeoutMs,
    expectedDashboardVersion,
    dashboardDomainPreflight,
    release: normalizedRelease,
    statusMentionsApi,
    dashboardShell,
  }

  if (outputPath) {
    const markdown = `# Beam Environment Parity Check

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- api base: \`${apiBase}\`
- site base: \`${siteBase}\`
- dashboard base: \`${dashboardBase}\`
- request timeout: \`${requestTimeoutMs}ms\`
- dashboard domain preflight: \`${dashboardDomainPreflight.checked ? 'checked' : 'skipped'}\`

## Result

\`PASS\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(path.resolve(outputPath), markdown)
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error('[production:parity] failed:', error)
  process.exitCode = 1
})
