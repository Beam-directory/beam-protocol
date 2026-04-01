import { copyFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const composeFile = path.join(repoRoot, 'ops/quickstart/compose.yaml')
const envPath = path.join(repoRoot, 'ops/quickstart/.env')
const envExamplePath = path.join(repoRoot, 'ops/quickstart/.env.example')

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
  run('docker', ['compose', '-f', composeFile, '--env-file', envPath, 'up', '-d', '--build'])
}

async function main() {
  await ensureQuickstartEnv()
  await ensureLocalStack()

  logStep('running the hosted quickstart smoke')
  run('node', [path.join(repoRoot, 'scripts/quickstart/smoke.mjs')])

  logStep('importing persistent OpenClaw agents, workspace agents, and recent subagents')
  run('node', [path.join(repoRoot, 'scripts/workspace/import-openclaw.mjs'), '--register-missing'])

  console.log('')
  console.log('Beam OpenClaw local setup finished.')
  console.log('Open the printed login link and then the openclaw-local workspace in the dashboard.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
