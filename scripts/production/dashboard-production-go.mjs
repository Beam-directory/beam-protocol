import { execFile as execFileCallback } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createDashboardDomainConfig, loadGoDaddyCredentials, runDashboardDomainPreflight } from './dashboard-domain-preflight.mjs'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const execFile = promisify(execFileCallback)
const localDashboardPackage = JSON.parse(readFileSync(path.join(repoRoot, 'packages/dashboard/package.json'), 'utf8'))

export function createDashboardProductionGoConfig({ argv = process.argv, env = process.env } = {}) {
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
  if (hasFlag('--apply-godaddy-cname')) {
    throw new Error('Use --apply-godaddy-dns with --record-type A or --record-type CNAME instead of --apply-godaddy-cname.')
  }

  const domain = optional('--domain', 'dashboard.beam.directory')
  const godaddyZone = optional('--godaddy-zone', 'beam.directory')
  const expectedRecordType = normalizeRecordType(optional('--record-type', hasFlag('--expected-cname') ? 'CNAME' : 'A'))
  const expectedRecordValue = normalizeDnsValue(optional(
    '--record-value',
    expectedRecordType === 'CNAME'
      ? optional('--expected-cname', 'cname.vercel-dns.com')
      : optional('--expected-a', '76.76.21.21'),
  ))

  return {
    domain,
    dashboardBase: optional('--dashboard-base', `https://${domain}`),
    expectedRecordType,
    expectedRecordValue,
    expectedCname: expectedRecordType === 'CNAME'
      ? expectedRecordValue
      : normalizeDnsValue(optional('--expected-cname', 'cname.vercel-dns.com')),
    expectedA: expectedRecordType === 'A'
      ? expectedRecordValue
      : normalizeDnsValue(optional('--expected-a', '76.76.21.21')),
    godaddyZone,
    godaddyRecord: optional('--godaddy-record', domain.replace(new RegExp(`\\.${escapeRegExp(godaddyZone)}$`, 'u'), '')),
    godaddyEnvPath: optional('--godaddy-env', env.GODADDY_ENV ?? null),
    godaddyTtl: numericValue('--godaddy-ttl', optional('--godaddy-ttl', '600'), 1),
    vercelProject: optional('--vercel-project', 'dashboard'),
    vercelScope: optional('--vercel-scope', 'alfridus1s-projects'),
    expectedDashboardVersion: optional('--expected-dashboard-version', localDashboardPackage.version),
    requestTimeoutMs: numericValue('--request-timeout-ms', optional('--request-timeout-ms', '15000'), 1),
    verifyTimeoutMs: numericValue('--verify-timeout-ms', optional('--verify-timeout-ms', '120000'), 0),
    verifyIntervalMs: numericValue('--verify-interval-ms', optional('--verify-interval-ms', '5000'), 0),
    applyVercelDomain: hasFlag('--apply-vercel-domain'),
    applyGoDaddyDns: hasFlag('--apply-godaddy-dns'),
    skipVercelInspect: hasFlag('--skip-vercel-inspect'),
    confirmation: optional('--confirm-production-change'),
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

function normalizeDnsValue(value) {
  return String(value).trim().replace(/\.$/u, '').toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function numericValue(name, raw, min) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function needsConfirmation(config) {
  return config.applyVercelDomain || config.applyGoDaddyDns
}

function assertConfirmed(config) {
  if (needsConfirmation(config) && config.confirmation !== config.domain) {
    throw new Error(`Refusing to change production without --confirm-production-change ${config.domain}`)
  }
}

function domainConfig(config, { timeoutMs = 0, intervalMs = 1000 } = {}) {
  const argv = [
    'node',
    'dashboard-domain-preflight.mjs',
    '--domain',
    config.domain,
    '--dashboard-base',
    config.dashboardBase,
    '--record-type',
    config.expectedRecordType,
    '--record-value',
    config.expectedRecordValue,
    '--expected-dashboard-version',
    config.expectedDashboardVersion,
    '--godaddy-zone',
    config.godaddyZone,
    '--godaddy-record',
    config.godaddyRecord,
    '--request-timeout-ms',
    String(config.requestTimeoutMs),
    '--timeout-ms',
    String(timeoutMs),
    '--interval-ms',
    String(intervalMs),
  ]
  if (config.godaddyEnvPath) {
    argv.push('--godaddy-env', config.godaddyEnvPath)
  }
  return createDashboardDomainConfig({ argv, env: process.env })
}

function plannedActions(config) {
  return {
    vercelDomain: {
      apply: config.applyVercelDomain,
      command: [
        'vercel',
        'domains',
        'add',
        config.domain,
        config.vercelProject,
        '--scope',
        config.vercelScope,
        '--non-interactive',
      ],
    },
    godaddyDns: {
      apply: config.applyGoDaddyDns,
      method: 'PUT',
      type: config.expectedRecordType,
      url: `https://api.godaddy.com/v1/domains/${encodeURIComponent(config.godaddyZone)}/records/${config.expectedRecordType}/${encodeURIComponent(config.godaddyRecord)}`,
      body: [{ data: config.expectedRecordValue, ttl: config.godaddyTtl }],
    },
  }
}

function cleanCliOutput(value) {
  return String(value ?? '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u0008/gu, '')
    .trim()
}

function summarizeCliError(error) {
  return {
    code: error?.code ?? null,
    message: cleanCliOutput(error?.message).slice(0, 240),
    stdout: cleanCliOutput(error?.stdout).slice(0, 240),
    stderr: cleanCliOutput(error?.stderr).slice(0, 240),
  }
}

async function runVercelCli(args, config, dependencies = {}) {
  const execFileImpl = dependencies.execFile ?? execFile
  const result = await execFileImpl('vercel', args, {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  return {
    command: ['vercel', ...args],
    stdout: cleanCliOutput(result.stdout),
    stderr: cleanCliOutput(result.stderr),
  }
}

function extractVercelRecommendedRecord(output) {
  const normalized = cleanCliOutput(output)
  const recommended = normalized.match(/`((?:A|CNAME)\s+[^`]+)`\s+\[recommended\]/iu)
  if (recommended) {
    return recommended[1]
  }
  return normalized.match(/`((?:A|CNAME)\s+[^`]+)`/iu)?.[1] ?? null
}

function parseVercelProjectInspect(output) {
  const normalized = cleanCliOutput(output)
  return {
    id: normalized.match(/\bID\s+([^\s]+)/u)?.[1] ?? null,
    name: normalized.match(/\bName\s+([^\s]+)/u)?.[1] ?? null,
    framework: normalized.match(/\bFramework Preset\s+([^\n]+)/u)?.[1]?.trim() ?? null,
    nodeVersion: normalized.match(/\bNode\.js Version\s+([^\n]+)/u)?.[1]?.trim() ?? null,
  }
}

function parseVercelDeploymentAliases(output) {
  return cleanCliOutput(output)
    .split(/\r?\n/u)
    .map((line) => line.match(/╶\s+https?:\/\/([^\s]+)/u)?.[1])
    .filter(Boolean)
}

function parseDashboardPackageVersionFromLogs(output) {
  const normalized = cleanCliOutput(output)
  return normalized.match(/>\s+@beam-protocol\/dashboard@([^\s]+)\s+build/u)?.[1] ?? null
}

function firstDeployment(payload) {
  if (Array.isArray(payload?.deployments)) {
    return payload.deployments[0] ?? null
  }
  if (Array.isArray(payload)) {
    return payload[0] ?? null
  }
  return null
}

async function inspectVercelDomain(config, dependencies = {}) {
  const args = ['domains', 'inspect', config.domain, '--scope', config.vercelScope]
  try {
    const result = await runVercelCli(args, config, dependencies)
    const output = `${result.stdout}\n${result.stderr}`
    return {
      checked: true,
      command: result.command,
      domain: config.domain,
      found: /domain .*found/i.test(output),
      configuredProperly: !/not configured properly|warning!/iu.test(output),
      recommendedRecord: extractVercelRecommendedRecord(output),
    }
  } catch (error) {
    return {
      checked: false,
      command: ['vercel', ...args],
      domain: config.domain,
      error: summarizeCliError(error),
    }
  }
}

async function inspectVercelProject(config, dependencies = {}) {
  const args = ['project', 'inspect', config.vercelProject, '--scope', config.vercelScope]
  try {
    const result = await runVercelCli(args, config, dependencies)
    return {
      checked: true,
      command: result.command,
      ...parseVercelProjectInspect(`${result.stdout}\n${result.stderr}`),
    }
  } catch (error) {
    return {
      checked: false,
      command: ['vercel', ...args],
      error: summarizeCliError(error),
    }
  }
}

async function inspectVercelProtection(config, dependencies = {}) {
  const args = ['project', 'protection', config.vercelProject, '--scope', config.vercelScope, '--format', 'json']
  try {
    const result = await runVercelCli(args, config, dependencies)
    const payload = JSON.parse(result.stdout)
    const deploymentType = payload?.ssoProtection?.deploymentType ?? null
    return {
      checked: true,
      command: result.command,
      projectId: payload?.projectId ?? null,
      name: payload?.name ?? null,
      ssoProtection: payload?.ssoProtection ?? null,
      customDomainsBypassSso: deploymentType === 'all_except_custom_domains',
      gitForkProtection: payload?.gitForkProtection ?? null,
      skewProtectionMaxAge: payload?.skewProtectionMaxAge ?? null,
    }
  } catch (error) {
    return {
      checked: false,
      command: ['vercel', ...args],
      error: summarizeCliError(error),
    }
  }
}

async function inspectLatestProductionDeployment(config, dependencies = {}) {
  const listArgs = [
    'list',
    config.vercelProject,
    '--scope',
    config.vercelScope,
    '--status',
    'READY',
    '--environment',
    'production',
    '--format',
    'json',
  ]
  try {
    const listResult = await runVercelCli(listArgs, config, dependencies)
    const latest = firstDeployment(JSON.parse(listResult.stdout))
    if (!latest?.url) {
      return {
        checked: true,
        command: listResult.command,
        latest: null,
        aliases: [],
        packageVersion: null,
        expectedPackageVersion: config.expectedDashboardVersion,
        packageVersionMatches: false,
      }
    }

    const inspectArgs = ['inspect', latest.url, '--scope', config.vercelScope]
    const logsArgs = ['inspect', latest.url, '--scope', config.vercelScope, '--logs']
    const [inspectResult, logsResult] = await Promise.all([
      runVercelCli(inspectArgs, config, dependencies),
      runVercelCli(logsArgs, config, dependencies),
    ])
    const packageVersion = parseDashboardPackageVersionFromLogs(`${logsResult.stdout}\n${logsResult.stderr}`)
    return {
      checked: true,
      command: listResult.command,
      inspectCommand: inspectResult.command,
      logsCommand: logsResult.command,
      latest: {
        url: latest.url,
        name: latest.name ?? null,
        state: latest.state ?? null,
        target: latest.target ?? null,
        createdAt: latest.createdAt ?? null,
        ready: latest.ready ?? null,
        gitCommitSha: latest.meta?.gitCommitSha ?? null,
        gitCommitRef: latest.meta?.gitCommitRef ?? null,
        gitCommitMessage: latest.meta?.gitCommitMessage ?? null,
        gitDirty: latest.meta?.gitDirty ?? null,
        dashboardVersionMeta: latest.meta?.beamDashboardVersion ?? null,
      },
      aliases: parseVercelDeploymentAliases(`${inspectResult.stdout}\n${inspectResult.stderr}`),
      packageVersion,
      expectedPackageVersion: config.expectedDashboardVersion,
      packageVersionMatches: packageVersion === config.expectedDashboardVersion,
    }
  } catch (error) {
    return {
      checked: false,
      command: ['vercel', ...listArgs],
      expectedPackageVersion: config.expectedDashboardVersion,
      error: summarizeCliError(error),
    }
  }
}

export async function inspectVercelState(config, dependencies = {}) {
  if (config.skipVercelInspect) {
    return {
      checked: false,
      reason: 'skipped by --skip-vercel-inspect',
    }
  }

  const [domain, project, protection, latestProductionDeployment] = await Promise.all([
    inspectVercelDomain(config, dependencies),
    inspectVercelProject(config, dependencies),
    inspectVercelProtection(config, dependencies),
    inspectLatestProductionDeployment(config, dependencies),
  ])

  return {
    checked: domain.checked || project.checked || protection.checked || latestProductionDeployment.checked,
    scope: config.vercelScope,
    projectName: config.vercelProject,
    domain,
    project,
    protection,
    latestProductionDeployment,
  }
}

async function applyVercelDomain(config, dependencies = {}) {
  const args = ['domains', 'add', config.domain, config.vercelProject, '--scope', config.vercelScope, '--non-interactive']
  const result = await runVercelCli(args, config, dependencies)
  return {
    ok: true,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function applyGoDaddyDns(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch
  const loadCredentials = dependencies.loadGoDaddyCredentials ?? loadGoDaddyCredentials
  const credentials = await loadCredentials(domainConfig(config), dependencies)
  if (!credentials) {
    throw new Error('GODADDY_API_KEY and GODADDY_API_SECRET are required to apply the GoDaddy DNS record.')
  }

  const url = `https://api.godaddy.com/v1/domains/${encodeURIComponent(config.godaddyZone)}/records/${config.expectedRecordType}/${encodeURIComponent(config.godaddyRecord)}`
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Authorization: `sso-key ${credentials.apiKey}:${credentials.apiSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ data: config.expectedRecordValue, ttl: config.godaddyTtl }]),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GoDaddy DNS update failed with HTTP ${response.status}: ${text.slice(0, 240)}`)
  }
  return {
    ok: true,
    method: 'PUT',
    url,
    status: response.status,
  }
}

export async function runDashboardProductionGo(config = createDashboardProductionGoConfig(), dependencies = {}) {
  assertConfirmed(config)

  const runPreflight = dependencies.runDashboardDomainPreflight ?? runDashboardDomainPreflight
  const inspectVercel = dependencies.inspectVercelState ?? inspectVercelState
  const [before, vercelBefore] = await Promise.all([
    runPreflight(domainConfig(config), dependencies),
    inspectVercel(config, dependencies),
  ])
  const actions = plannedActions(config)
  const mode = needsConfirmation(config) ? 'apply' : 'dry-run'
  const applied = []

  if (config.applyVercelDomain) {
    applied.push({ name: 'vercelDomain', result: await applyVercelDomain(config, dependencies) })
  }
  if (config.applyGoDaddyDns) {
    applied.push({ name: 'godaddyDns', result: await applyGoDaddyDns(config, dependencies) })
  }

  const after = mode === 'apply'
    ? await runPreflight(domainConfig(config, {
      timeoutMs: config.verifyTimeoutMs,
      intervalMs: config.verifyIntervalMs,
    }), dependencies)
    : null
  const vercelAfter = mode === 'apply'
    ? await inspectVercel(config, dependencies)
    : null

  return {
    ok: mode === 'apply' ? after.ok : true,
    ready: mode === 'apply' ? after.ok : before.ok,
    mode,
    date: formatDate(),
    generatedAt: formatDateTime(),
    domain: config.domain,
    dashboardBase: config.dashboardBase,
    expectedRecordType: config.expectedRecordType,
    expectedRecordValue: config.expectedRecordValue,
    expectedDashboardVersion: config.expectedDashboardVersion,
    expectedCname: config.expectedCname,
    expectedA: config.expectedA,
    vercelBefore,
    plannedActions: actions,
    preflightBefore: before,
    applied,
    preflightAfter: after,
    vercelAfter,
  }
}

async function main() {
  const config = createDashboardProductionGoConfig()
  const result = await runDashboardProductionGo(config)

  if (config.outputPath) {
    const markdown = `# Beam Dashboard Production GO

## Context

- generated at: \`${formatDateTime()}\`
- mode: \`${result.mode}\`
- domain: \`${result.domain}\`
- dashboard base: \`${result.dashboardBase}\`
- expected DNS record: \`${result.expectedRecordType} ${config.godaddyRecord} ${result.expectedRecordValue}\`

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
    console.error('[production:dashboard-go] failed:', error)
    process.exitCode = 1
  })
}
