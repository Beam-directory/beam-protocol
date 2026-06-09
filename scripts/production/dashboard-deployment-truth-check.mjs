import { execFile as execFileCallback } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const execFile = promisify(execFileCallback)
const localDashboardPackage = JSON.parse(readFileSync(path.join(repoRoot, 'packages/dashboard/package.json'), 'utf8'))

export function createDashboardDeploymentTruthConfig({ argv = process.argv, env = process.env } = {}) {
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
    deploymentUrl: normalizeDeploymentUrl(optional('--deployment-url', env.VERCEL_DEPLOYMENT_URL ?? null)),
    requiredAlias: normalizeDeploymentUrl(optional('--required-alias', 'dashboard.beam.directory')),
    expectedDashboardVersion: optional('--expected-dashboard-version', localDashboardPackage.version),
    vercelProject: optional('--vercel-project', 'dashboard'),
    vercelScope: optional('--vercel-scope', 'alfridus1s-projects'),
    vercelToken: optional('--vercel-token', env.VERCEL_TOKEN ?? null),
    requireLatestProduction: !hasFlag('--skip-latest-production'),
    timeoutMs: numericValue('--timeout-ms', optional('--timeout-ms', '0'), 0),
    intervalMs: numericValue('--interval-ms', optional('--interval-ms', '1000'), 0),
    requestTimeoutMs: numericValue('--request-timeout-ms', optional('--request-timeout-ms', '30000'), 1),
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

function normalizeDeploymentUrl(value) {
  if (!value) {
    return null
  }
  return String(value).trim().replace(/^https?:\/\//iu, '').replace(/\/+$/u, '')
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
  const commandArgs = [...args, '--scope', config.vercelScope]
  if (config.vercelToken) {
    commandArgs.push('--token', config.vercelToken)
  }
  const result = await execFileImpl('vercel', commandArgs, {
    encoding: 'utf8',
    timeout: config.requestTimeoutMs,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  return {
    command: ['vercel', ...args, '--scope', config.vercelScope, ...(config.vercelToken ? ['--token', '[redacted]'] : [])],
    stdout: cleanCliOutput(result.stdout),
    stderr: cleanCliOutput(result.stderr),
  }
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

function parseAliases(output) {
  return cleanCliOutput(output)
    .split(/\r?\n/u)
    .map((line) => line.match(/╶\s+https?:\/\/([^\s]+)/u)?.[1])
    .filter(Boolean)
}

function parseDashboardVersion(output) {
  return cleanCliOutput(output).match(/>\s+@beam-protocol\/dashboard@([^\s]+)\s+build/u)?.[1] ?? null
}

async function inspectLatestProduction(config, dependencies = {}) {
  const result = await runVercelCli([
    'list',
    config.vercelProject,
    '--status',
    'READY',
    '--environment',
    'production',
    '--format',
    'json',
  ], config, dependencies)
  const latest = firstDeployment(JSON.parse(result.stdout))
  return {
    command: result.command,
    latest: latest
      ? {
          url: normalizeDeploymentUrl(latest.url),
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
        }
      : null,
  }
}

async function inspectDeployment(config, deploymentUrl, dependencies = {}) {
  const [inspectResult, logsResult] = await Promise.all([
    runVercelCli(['inspect', deploymentUrl], config, dependencies),
    runVercelCli(['inspect', deploymentUrl, '--logs'], config, dependencies),
  ])
  return {
    inspectCommand: inspectResult.command,
    logsCommand: logsResult.command,
    aliases: parseAliases(`${inspectResult.stdout}\n${inspectResult.stderr}`),
    packageVersion: parseDashboardVersion(`${logsResult.stdout}\n${logsResult.stderr}`),
  }
}

async function runAttempt(config, dependencies = {}) {
  let latest = null
  let deploymentUrl = config.deploymentUrl
  const failures = []

  if (config.requireLatestProduction || !deploymentUrl) {
    latest = await inspectLatestProduction(config, dependencies)
    deploymentUrl = deploymentUrl ?? latest.latest?.url ?? null
  }

  if (!deploymentUrl) {
    failures.push('No deployment URL was provided and no latest READY production deployment was found.')
    return {
      ok: false,
      failures,
      latestProduction: latest,
      deployment: null,
    }
  }

  const deployment = await inspectDeployment(config, deploymentUrl, dependencies)
  if (config.requireLatestProduction && latest?.latest?.url !== deploymentUrl) {
    failures.push(`Deployment ${deploymentUrl} is not the latest READY production deployment${latest?.latest?.url ? ` (${latest.latest.url})` : ''}.`)
  }
  if (deployment.packageVersion !== config.expectedDashboardVersion) {
    failures.push(`Dashboard deployment package version is ${deployment.packageVersion ?? 'unknown'}; expected ${config.expectedDashboardVersion}.`)
  }
  if (latest?.latest?.url === deploymentUrl && latest.latest.dashboardVersionMeta !== config.expectedDashboardVersion) {
    failures.push(`Dashboard deployment metadata beamDashboardVersion is ${latest.latest.dashboardVersionMeta ?? 'missing'}; expected ${config.expectedDashboardVersion}.`)
  }
  if (config.requiredAlias && !deployment.aliases.includes(config.requiredAlias)) {
    failures.push(`Dashboard deployment does not list required alias ${config.requiredAlias}.`)
  }

  return {
    ok: failures.length === 0,
    failures,
    latestProduction: latest,
    deployment: {
      url: deploymentUrl,
      aliases: deployment.aliases,
      packageVersion: deployment.packageVersion,
      expectedPackageVersion: config.expectedDashboardVersion,
      packageVersionMatches: deployment.packageVersion === config.expectedDashboardVersion,
      metadataVersion: latest?.latest?.url === deploymentUrl ? latest.latest.dashboardVersionMeta : null,
      metadataVersionMatches: latest?.latest?.url === deploymentUrl
        ? latest.latest.dashboardVersionMeta === config.expectedDashboardVersion
        : false,
      requiredAlias: config.requiredAlias,
      requiredAliasPresent: config.requiredAlias ? deployment.aliases.includes(config.requiredAlias) : true,
      inspectCommand: deployment.inspectCommand,
      logsCommand: deployment.logsCommand,
    },
  }
}

export async function runDashboardDeploymentTruthCheck(config = createDashboardDeploymentTruthConfig(), dependencies = {}) {
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const startedAt = Date.now()
  const deadline = startedAt + config.timeoutMs
  let attempts = 0
  let result

  do {
    attempts += 1
    try {
      result = await runAttempt(config, dependencies)
    } catch (error) {
      result = {
        ok: false,
        failures: [`Could not inspect dashboard deployment truth: ${error.message}`],
        error: summarizeCliError(error),
      }
    }

    result = {
      ...result,
      date: formatDate(),
      generatedAt: formatDateTime(),
      vercelProject: config.vercelProject,
      vercelScope: config.vercelScope,
      deploymentUrl: config.deploymentUrl,
      requiredAlias: config.requiredAlias,
      expectedDashboardVersion: config.expectedDashboardVersion,
      requireLatestProduction: config.requireLatestProduction,
      attempts,
      elapsedMs: Date.now() - startedAt,
    }

    if (result.ok || config.intervalMs === 0 || Date.now() >= deadline) {
      return result
    }
    await sleep(Math.min(config.intervalMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)

  return result
}

async function main() {
  const config = createDashboardDeploymentTruthConfig()
  const result = await runDashboardDeploymentTruthCheck(config)

  if (config.outputPath) {
    const markdown = `# Beam Dashboard Deployment Truth Check

## Context

- generated at: \`${formatDateTime()}\`
- deployment URL: \`${config.deploymentUrl ?? 'latest READY production'}\`
- required alias: \`${config.requiredAlias ?? 'none'}\`
- expected dashboard version: \`${config.expectedDashboardVersion}\`

## Result

\`${result.ok ? 'PASS' : 'FAIL'}\`

## Failures

${result.failures.length === 0 ? '- none' : result.failures.map((failure) => `- ${failure}`).join('\n')}

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
    console.error('[production:dashboard-deployment] failed:', error)
    process.exitCode = 1
  })
}
