import { copyFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const composeFile = path.join(repoRoot, 'ops/quickstart/compose.yaml')
const envPath = path.join(repoRoot, 'ops/quickstart/.env')
const envExamplePath = path.join(repoRoot, 'ops/quickstart/.env.example')
const watchMode = process.argv.includes('--watch')
const daemonMode = process.argv.includes('--daemon')
const skipSpawnHookInstall = process.argv.includes('--skip-spawn-hook-install')
const nodePath = process.execPath
const dockerPath = fs.existsSync('/opt/homebrew/bin/docker')
  ? '/opt/homebrew/bin/docker'
  : fs.existsSync('/usr/local/bin/docker')
    ? '/usr/local/bin/docker'
    : 'docker'

function logStep(message) {
  console.log(`[openclaw-setup] ${message}`)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
}

async function ensureQuickstartEnv() {
  if (!fs.existsSync(envPath)) {
    await copyFile(envExamplePath, envPath)
    logStep('created ops/quickstart/.env from .env.example')
  }
}

async function isHealthy(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function ensureLocalStack() {
  const [directoryOk, dashboardOk, demoOk] = await Promise.all([
    isHealthy('http://127.0.0.1:43100/health'),
    isHealthy('http://127.0.0.1:43173/'),
    isHealthy('http://127.0.0.1:43290/health'),
  ])

  if (directoryOk && dashboardOk && demoOk) {
    logStep('local Beam quickstart stack already looks healthy')
    return
  }

  logStep('starting the local Beam quickstart stack with docker compose')
  run(dockerPath, ['compose', '-f', composeFile, '--env-file', envPath, 'up', '-d', '--build'])
}

async function main() {
  await ensureQuickstartEnv()
  await ensureLocalStack()

  if (!daemonMode) {
    logStep('running the hosted quickstart smoke')
    run(nodePath, [path.join(repoRoot, 'scripts/quickstart/smoke.mjs')])
  }

  if (watchMode) {
    logStep(daemonMode
      ? 'starting daemon OpenClaw sync for agents, workspace agents, and subagents'
      : 'starting live OpenClaw sync for agents, workspace agents, and subagents')
    run(nodePath, [path.join(repoRoot, 'scripts/workspace/import-openclaw.mjs'), '--register-missing', '--watch'])
    return
  }

  logStep('importing persistent OpenClaw agents, workspace agents, and recent subagents')
  run('node', [path.join(repoRoot, 'scripts/workspace/import-openclaw.mjs'), '--register-missing'])

  if (!skipSpawnHookInstall) {
    logStep('installing the direct OpenClaw spawn hook')
    run(nodePath, [path.join(repoRoot, 'scripts/workspace/install-openclaw-spawn-hook.mjs')])
  }

  console.log('')
  console.log('Beam OpenClaw local setup finished.')
  console.log('Open the printed login link and then the openclaw-local workspace in the dashboard.')
  if (!skipSpawnHookInstall) {
    console.log('Fresh OpenClaw subagents will now sync into Beam directly at spawn time.')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
