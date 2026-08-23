import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createDashboardProductionGoConfig, runDashboardProductionGo } from './dashboard-production-go.mjs'
import { createExternalDogfoodConfig, evaluateExternalDogfoodEvidence } from './external-dogfood-evidence-check.mjs'
import { createMcpPilotConfig, evaluateMcpPilotEvidence } from './mcp-pilot-evidence-check.mjs'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const execFile = promisify(execFileCallback)
const defaultEvidencePath = path.join(repoRoot, 'reports/1.7.0-external-dogfood-evidence.json')
const defaultMcpEvidencePath = path.join(repoRoot, 'reports/1.7.0-mcp-pilot-evidence.json')

export function createProductionReadinessConfig({ argv = process.argv, env = process.env } = {}) {
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

  return {
    release: optional('--release', '1.7.0'),
    evidencePath: optional('--evidence', defaultEvidencePath),
    mcpEvidencePath: optional('--mcp-evidence', defaultMcpEvidencePath),
    godaddyEnvPath: optional('--godaddy-env', env.GODADDY_ENV ?? null),
    dashboardDomain: optional('--dashboard-domain', 'dashboard.beam.directory'),
    dashboardBase: optional('--dashboard-base', 'https://dashboard.beam.directory'),
    recordType: optional('--record-type', 'A'),
    recordValue: optional('--record-value', '76.76.21.21'),
    requestTimeoutMs: numericValue('--request-timeout-ms', optional('--request-timeout-ms', '15000'), 1),
    vercelProject: optional('--vercel-project', 'dashboard'),
    vercelScope: optional('--vercel-scope', 'alfridus1s-projects'),
    githubIssue: numericValue('--github-issue', optional('--github-issue', '196'), 1),
    githubWorkflow: optional('--github-workflow', 'Deploy Dashboard'),
    skipGithub: hasFlag('--skip-github'),
    skipVercelInspect: hasFlag('--skip-vercel-inspect'),
    outputPath: optional('--output'),
  }
}

function numericValue(name, raw, min) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function dashboardConfigFor(config) {
  const argv = [
    'node',
    'dashboard-production-go.mjs',
    '--domain',
    config.dashboardDomain,
    '--dashboard-base',
    config.dashboardBase,
    '--record-type',
    config.recordType,
    '--record-value',
    config.recordValue,
    '--request-timeout-ms',
    String(config.requestTimeoutMs),
    '--vercel-project',
    config.vercelProject,
    '--vercel-scope',
    config.vercelScope,
  ]
  if (config.godaddyEnvPath) {
    argv.push('--godaddy-env', config.godaddyEnvPath)
  }
  if (config.skipVercelInspect) {
    argv.push('--skip-vercel-inspect')
  }
  return createDashboardProductionGoConfig({ argv, env: process.env })
}

function externalDogfoodConfigFor(config) {
  return createExternalDogfoodConfig({
    argv: [
      'node',
      'external-dogfood-evidence-check.mjs',
      '--release',
      config.release,
      '--evidence',
      config.evidencePath,
    ],
  })
}

function mcpPilotConfigFor(config) {
  return createMcpPilotConfig({
    argv: [
      'node',
      'mcp-pilot-evidence-check.mjs',
      '--release',
      config.release,
      '--evidence',
      config.mcpEvidencePath,
    ],
  })
}

async function runExternalDogfoodGate(config, dependencies = {}) {
  const readFileImpl = dependencies.readFile ?? readFile
  const dogfoodConfig = externalDogfoodConfigFor(config)
  const evidencePath = path.resolve(dogfoodConfig.evidencePath)
  let evidence
  try {
    evidence = JSON.parse(await readFileImpl(evidencePath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      evidencePath,
      counts: {},
      failures: [`Could not read external dogfood evidence at ${evidencePath}: ${error.message}`],
    }
  }

  const evaluation = evaluateExternalDogfoodEvidence(evidence, dogfoodConfig)
  return {
    ok: evaluation.ok,
    evidencePath,
    counts: evaluation.counts,
    failures: evaluation.failures,
  }
}

async function runMcpPilotGate(config, dependencies = {}) {
  const readFileImpl = dependencies.readFile ?? readFile
  const mcpConfig = mcpPilotConfigFor(config)
  const evidencePath = path.resolve(mcpConfig.evidencePath)
  let evidence
  try {
    evidence = JSON.parse(await readFileImpl(evidencePath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      evidencePath,
      counts: {},
      failures: [`Could not read hosted MCP pilot evidence at ${evidencePath}: ${error.message}`],
    }
  }

  const evaluation = evaluateMcpPilotEvidence(evidence, mcpConfig)
  return {
    ok: evaluation.ok,
    evidencePath,
    counts: evaluation.counts,
    failures: evaluation.failures,
  }
}

async function ghJson(args, dependencies = {}, timeoutMs = 15_000) {
  const execFileImpl = dependencies.execFile ?? execFile
  const result = await execFileImpl('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(String(result.stdout ?? 'null'))
}

function summarizeCliError(error) {
  return {
    code: error?.code ?? null,
    message: String(error?.message ?? '').slice(0, 240),
    stdout: String(error?.stdout ?? '').slice(0, 240),
    stderr: String(error?.stderr ?? '').slice(0, 240),
  }
}

export async function inspectGithubReadiness(config, dependencies = {}) {
  if (config.skipGithub) {
    return {
      ok: false,
      checked: false,
      failures: ['GitHub readiness check skipped.'],
    }
  }

  try {
    const [issue, runs] = await Promise.all([
      ghJson([
        'issue',
        'view',
        String(config.githubIssue),
        '--json',
        'number,state,title,url,updatedAt',
      ], dependencies, config.requestTimeoutMs),
      ghJson([
        'run',
        'list',
        '--workflow',
        config.githubWorkflow,
        '--limit',
        '1',
        '--json',
        'databaseId,status,conclusion,headSha,createdAt,updatedAt,displayTitle,url',
      ], dependencies, config.requestTimeoutMs),
    ])
    const latestRun = Array.isArray(runs) ? runs[0] ?? null : null
    const failures = []
    if (issue?.state !== 'CLOSED') {
      failures.push(`GitHub issue #${config.githubIssue} is ${issue?.state ?? 'missing'}.`)
    }
    if (!latestRun) {
      failures.push(`No GitHub Actions run found for workflow ${config.githubWorkflow}.`)
    } else if (latestRun.status !== 'completed' || latestRun.conclusion !== 'success') {
      failures.push(`Latest ${config.githubWorkflow} run is ${latestRun.status}/${latestRun.conclusion}.`)
    }

    return {
      ok: failures.length === 0,
      checked: true,
      issue,
      latestRun,
      failures,
    }
  } catch (error) {
    return {
      ok: false,
      checked: false,
      failures: [`Could not inspect GitHub readiness: ${error.message}`],
      error: summarizeCliError(error),
    }
  }
}

function dashboardBlockers(dashboard) {
  const failures = []
  if (!dashboard.ready) {
    const preflight = dashboard.preflightBefore
    const publicStatus = preflight?.publicDns?.expectedRecordPresent === true
      ? 'present'
      : preflight?.publicDns?.errors?.a?.code ?? preflight?.publicDns?.errors?.cname?.code ?? 'missing'
    const godaddyStatus = preflight?.godaddy?.checked
      ? (preflight.godaddy.expectedRecordPresent ? 'present' : 'missing')
      : 'not checked'
    const shellStatus = preflight?.dashboard?.shellReady
      ? 'ready'
      : preflight?.dashboard?.error?.code ?? `HTTP ${preflight?.dashboard?.status ?? 'unknown'}`
    failures.push(`Dashboard production domain is not ready: public DNS=${publicStatus}; GoDaddy=${godaddyStatus}; shell=${shellStatus}.`)
  }
  const vercel = dashboard.vercelBefore
  if (vercel?.checked !== true) {
    failures.push(`Vercel inspection is incomplete${vercel?.reason ? `: ${vercel.reason}` : ''}.`)
  }
  if (vercel?.domain?.checked !== true) {
    failures.push('Vercel domain inspection did not complete.')
  } else if (vercel.domain.configuredProperly !== true) {
    failures.push(`Vercel domain is not configured properly${vercel.domain.recommendedRecord ? `; recommended record is ${vercel.domain.recommendedRecord}` : ''}.`)
  }
  if (vercel?.project?.checked !== true) {
    failures.push('Vercel project inspection did not complete.')
  }
  if (vercel?.protection?.checked !== true) {
    failures.push('Vercel project-protection inspection did not complete.')
  } else if (vercel.protection.customDomainsBypassSso !== true) {
    failures.push('Vercel project protection does not currently exempt custom domains from SSO.')
  }
  const deployment = vercel?.latestProductionDeployment
  if (deployment?.checked !== true) {
    failures.push('Latest Vercel production deployment inspection did not complete.')
  } else if (deployment.packageVersionMatches !== true) {
    failures.push(`Latest Vercel production dashboard deployment version is ${deployment.packageVersion ?? 'unknown'}; expected ${deployment.expectedPackageVersion}.`)
  }
  if (deployment?.checked && deployment.latest?.dashboardVersionMeta !== deployment.expectedPackageVersion) {
    failures.push(`Latest Vercel production dashboard deployment metadata beamDashboardVersion is ${deployment.latest?.dashboardVersionMeta ?? 'missing'}; expected ${deployment.expectedPackageVersion}.`)
  }
  if (deployment?.checked && deployment.aliases && !deployment.aliases.includes(dashboard.domain)) {
    failures.push(`Latest Vercel production dashboard deployment does not list ${dashboard.domain} as an alias.`)
  }
  return failures
}

export async function runProductionReadinessGate(config = createProductionReadinessConfig(), dependencies = {}) {
  const runDashboard = dependencies.runDashboardProductionGo ?? runDashboardProductionGo
  const runDogfood = dependencies.runExternalDogfoodGate ?? runExternalDogfoodGate
  const runMcpPilot = dependencies.runMcpPilotGate ?? runMcpPilotGate
  const inspectGithub = dependencies.inspectGithubReadiness ?? inspectGithubReadiness

  const [dashboard, dogfood, mcpPilot, github] = await Promise.all([
    runDashboard(dashboardConfigFor(config), dependencies),
    runDogfood(config, dependencies),
    runMcpPilot(config, dependencies),
    inspectGithub(config, dependencies),
  ])

  const blockers = [
    ...dashboardBlockers(dashboard),
    ...dogfood.failures.map((failure) => `External dogfood: ${failure}`),
    ...mcpPilot.failures.map((failure) => `Hosted MCP pilot: ${failure}`),
    ...github.failures.map((failure) => `GitHub: ${failure}`),
  ]

  return {
    ok: blockers.length === 0,
    date: formatDate(),
    generatedAt: formatDateTime(),
    release: config.release,
    dashboard,
    externalDogfood: dogfood,
    mcpPilot,
    github,
    blockers,
  }
}

async function main() {
  const config = createProductionReadinessConfig()
  const result = await runProductionReadinessGate(config)

  if (config.outputPath) {
    const markdown = `# Beam Production Readiness Gate

## Context

- generated at: \`${formatDateTime()}\`
- release: \`${config.release}\`
- dashboard domain: \`${config.dashboardDomain}\`
- evidence path: \`${path.resolve(config.evidencePath)}\`
- MCP pilot evidence path: \`${path.resolve(config.mcpEvidencePath)}\`

## Result

\`${result.ok ? 'PASS' : 'FAIL'}\`

## Blockers

${result.blockers.length === 0 ? '- none' : result.blockers.map((blocker) => `- ${blocker}`).join('\n')}

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
    console.error('[production:readiness] failed:', error)
    process.exitCode = 1
  })
}
