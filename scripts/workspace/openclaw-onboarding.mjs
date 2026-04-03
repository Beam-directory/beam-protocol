import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const nodePath = process.execPath
const hostScript = path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')
const uiSmokeScript = path.join(repoRoot, 'scripts/quickstart/dashboard-ui-smoke.mjs')

const passthroughArgs = process.argv.slice(2)
const skipUiSmoke = passthroughArgs.includes('--skip-ui-smoke')
const setupArgs = passthroughArgs.filter((value) => value !== '--skip-ui-smoke')

function logStep(message) {
  console.log(`[openclaw-onboarding] ${message}`)
}

function runNode(args, { capture = false } = {}) {
  return execFileSync(nodePath, args, {
    cwd: repoRoot,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  })
}

function parseJsonCommand(args) {
  const output = runNode(args, { capture: true })
  return JSON.parse(output)
}

function formatReadyState(status) {
  if (!status?.host) {
    return 'status unavailable'
  }
  if (!status.host.credentialPresent) {
    return 'waiting for host credential'
  }
  if (status.host.fleetHealth && status.host.fleetHealth !== 'healthy') {
    return `host health ${status.host.fleetHealth}`
  }
  return 'ready for local Beam messaging'
}

async function main() {
  logStep('running unified Beam OpenClaw setup')
  runNode([hostScript, 'setup', ...setupArgs])

  logStep('reading post-setup host status')
  const status = parseJsonCommand([hostScript, 'status', '--json'])

  let uiSmoke = null
  if (!skipUiSmoke) {
    logStep('capturing dashboard proof')
    uiSmoke = parseJsonCommand([uiSmokeScript, '--json'])
  }

  console.log('')
  console.log('Beam OpenClaw onboarding finished.')
  if (status.loginUrl) {
    console.log(`Login:           ${status.loginUrl}`)
  }
  console.log(`Workspace:       ${status.workspaceUrl}`)
  console.log(`OpenClaw Fleet:  ${status.fleetUrl}`)
  console.log(`Ready:           ${formatReadyState(status)}`)
  console.log(`Host:            ${status.host.label}`)
  console.log(`Routes:          ${status.host.routeCount ?? status.runtime.totalRoutes}`)
  console.log(`Runtime:         ${status.runtime.persistent} persistent · ${status.runtime.workspaceAgents} workspace · ${status.runtime.gatewayAgents} gateway · ${status.runtime.subagents} subagents`)
  if (uiSmoke) {
    console.log(`UI smoke:        ${uiSmoke.outputDir}`)
  }
}

main().catch((error) => {
  console.error('[openclaw-onboarding] failed:', error)
  process.exit(1)
})
