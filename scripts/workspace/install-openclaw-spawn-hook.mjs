import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const uninstall = process.argv.includes('--uninstall')
const hookId = 'beam-subagent-sync'
const hookRoot = path.join(os.homedir(), '.openclaw/hooks', hookId)
const hookDocPath = path.join(hookRoot, 'HOOK.md')
const handlerPath = path.join(hookRoot, 'handler.js')
const syncScriptPath = path.join(repoRoot, 'scripts/workspace/openclaw-subagent-spawn-sync.mjs')

function logStep(message) {
  console.log(`[openclaw-spawn-hook] ${message}`)
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  })

  if (result.status !== 0 && !allowFailure) {
    const details = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}${details ? `: ${details}` : ''}`)
  }

  return result
}

function restartGatewayIfPresent() {
  const list = run('launchctl', ['list'], { allowFailure: true })
  if (!list.stdout.includes('ai.openclaw.gateway')) {
    logStep('ai.openclaw.gateway not found; skipping restart')
    return
  }

  const uid = run('id', ['-u']).stdout.trim()
  run('launchctl', ['kickstart', '-k', `gui/${uid}/ai.openclaw.gateway`], { allowFailure: false })
  logStep('restarted ai.openclaw.gateway')
}

function buildHookDocument() {
  return `---
name: ${hookId}
description: "Sync freshly spawned OpenClaw subagents straight into Beam workspaces"
metadata:
  openclaw:
    emoji: "🔗"
    events:
      - "subagent_spawned"
---

# Beam Subagent Sync

Registers every new OpenClaw subagent in Beam as soon as OpenClaw emits \`subagent_spawned\`.

## What it does

- creates or refreshes a Beam identity for the spawned subagent
- binds it into the \`openclaw-local\` Beam workspace
- keeps the merged Beam identity file in sync for local Beam sends
`
}

function buildHandlerModule() {
  return `import { spawn } from 'node:child_process'

const nodePath = ${JSON.stringify(process.execPath)}
const syncScriptPath = ${JSON.stringify(syncScriptPath)}

export default async function beamSubagentSync(event, ctx = {}) {
  const args = [
    syncScriptPath,
    '--child-session-key', String(event.childSessionKey ?? ''),
    '--requester-session-key', String(ctx.requesterSessionKey ?? ''),
    '--run-id', String(event.runId ?? ''),
    '--agent-id', String(event.agentId ?? ''),
  ]

  if (typeof event.label === 'string' && event.label.trim().length > 0) {
    args.push('--label', event.label.trim())
  }

  const child = spawn(nodePath, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })

  child.unref()
}
`
}

async function installHook() {
  await mkdir(hookRoot, { recursive: true })
  await writeFile(hookDocPath, buildHookDocument(), 'utf8')
  await writeFile(handlerPath, buildHandlerModule(), 'utf8')
  logStep(`wrote managed hook into ${hookRoot}`)

  run('openclaw', ['hooks', 'enable', hookId])
  logStep(`enabled ${hookId}`)
  restartGatewayIfPresent()
}

async function uninstallHook() {
  run('openclaw', ['hooks', 'disable', hookId], { allowFailure: true })
  await rm(hookRoot, { recursive: true, force: true })
  logStep(`removed ${hookId}`)
  restartGatewayIfPresent()
}

async function main() {
  if (uninstall) {
    await uninstallHook()
    return
  }

  await installHook()
}

await main()
