import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { optionalFlag, requestJson } from '../production/shared.mjs'
import { loadOpenClawRuntimeState } from './openclaw-runtime-state.mjs'

const directoryUrl = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL || 'http://localhost:43100')
const dashboardUrl = optionalFlag('--dashboard-url', process.env.BEAM_DASHBOARD_URL || 'http://localhost:43173')
const adminEmail = optionalFlag('--email', process.env.BEAM_ADMIN_EMAIL || 'ops@beam.local')
const workspaceSlug = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG || 'openclaw-local')
const liveLimit = Number.parseInt(optionalFlag('--live-limit', '12'), 10)
const receiverPlistPath = path.join(os.homedir(), 'Library/LaunchAgents/com.beam.openclaw-receiver.plist')
const liveSyncPlistPath = path.join(os.homedir(), 'Library/LaunchAgents/com.beam.openclaw-live.plist')
const spawnHookPath = path.join(os.homedir(), '.openclaw/hooks/beam-subagent-sync')

function createAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function formatBool(value) {
  return value ? 'yes' : 'no'
}

function formatSummaryStatus(options) {
  if (options.receiverRunning && options.liveBindings > 0) {
    return 'ready for local Beam messaging'
  }
  if (options.importedBindings > 0) {
    return 'imported, but live delivery still needs attention'
  }
  return 'not imported yet'
}

function launchAgentState(label) {
  const uid = String(process.getuid())
  const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  })
  return result.status === 0
}

async function createAdminSession() {
  const challenge = await requestJson(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: dashboardUrl,
    },
    body: JSON.stringify({ email: adminEmail }),
  })

  const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  return {
    token: verify.token,
    magicUrl: challenge.url,
  }
}

async function main() {
  const [runtimeState, adminSession] = await Promise.all([
    loadOpenClawRuntimeState(),
    createAdminSession(),
  ])

  const adminHeaders = createAdminHeaders(adminSession.token)
  const [overview, identities] = await Promise.all([
    requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/overview`, {
      headers: { Authorization: adminHeaders.Authorization },
    }),
    requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
      headers: { Authorization: adminHeaders.Authorization },
    }),
  ])

  const openclawBindings = identities.bindings.filter((binding) => (binding.runtime.connector ?? '').startsWith('openclaw'))
  const liveBindings = openclawBindings.filter((binding) => binding.runtime.connected)
  const websocketBindings = openclawBindings.filter((binding) => binding.runtime.deliveryMode === 'websocket' || binding.runtime.deliveryMode === 'hybrid')
  const staleBindings = openclawBindings.filter((binding) => binding.lifecycleStatus === 'stale')
  const receiverInstalled = fs.existsSync(receiverPlistPath)
  const receiverRunning = receiverInstalled && launchAgentState('com.beam.openclaw-receiver')
  const liveSyncInstalled = fs.existsSync(liveSyncPlistPath)
  const liveSyncRunning = liveSyncInstalled && launchAgentState('com.beam.openclaw-live')
  const hookInstalled = fs.existsSync(spawnHookPath)
  const summaryStatus = formatSummaryStatus({
    receiverRunning,
    liveBindings: liveBindings.length,
    importedBindings: openclawBindings.length,
  })

  console.log('')
  console.log('Beam OpenClaw status')
  console.log('')
  console.log(`Overall status:    ${summaryStatus}`)
  console.log('')
  console.log('Open in browser')
  console.log(`- login:           ${adminSession.magicUrl}`)
  console.log(`- workspace:       ${dashboardUrl}/workspaces?workspace=${encodeURIComponent(workspaceSlug)}`)
  console.log(`- traces:          ${dashboardUrl}/intents`)
  console.log('')
  console.log('Local services')
  console.log(`- receiver installed: ${formatBool(receiverInstalled)}`)
  console.log(`- receiver running:   ${formatBool(receiverRunning)}`)
  console.log(`- live sync installed:${formatBool(liveSyncInstalled)}`)
  console.log(`- live sync running:  ${formatBool(liveSyncRunning)}`)
  console.log(`- spawn hook active:  ${formatBool(hookInstalled)}`)
  console.log('')
  console.log('Workspace summary')
  console.log(`- imported identities: ${openclawBindings.length}`)
  console.log(`- live Beam routes:    ${liveBindings.length}`)
  console.log(`- websocket-capable:   ${websocketBindings.length}`)
  console.log(`- stale identities:    ${staleBindings.length}`)
  console.log(`- manual review:       ${overview.summary.pendingApprovals}`)
  console.log(`- external ready:      ${overview.summary.externalReadyIdentities}`)
  console.log('')
  console.log('Discovery sources')
  console.log(`- persistent folders:  ${runtimeState.counts.persistentAgents}`)
  console.log(`- workspace agents:    ${runtimeState.counts.workspaceAgents}`)
  console.log(`- gateway agents:      ${runtimeState.counts.gatewayAgents}`)
  console.log(`- active subagents:    ${runtimeState.counts.subagents}`)
  console.log(`- unique routes:       ${runtimeState.routes.length}`)
  console.log('')

  if (liveBindings.length > 0) {
    console.log('Live routes')
    for (const binding of liveBindings.slice(0, liveLimit)) {
      const label = binding.identity.displayName || binding.beamId
      console.log(`- ${label} · ${binding.beamId} · ${binding.runtime.deliveryMode || 'unknown'}`)
    }
    if (liveBindings.length > liveLimit) {
      console.log(`- ... and ${liveBindings.length - liveLimit} more`)
    }
    console.log('')
  }

  if (staleBindings.length > 0) {
    console.log('Stale routes')
    for (const binding of staleBindings.slice(0, 8)) {
      console.log(`- ${binding.beamId}`)
    }
    if (staleBindings.length > 8) {
      console.log(`- ... and ${staleBindings.length - 8} more`)
    }
    console.log('')
  }

  console.log('Next steps')
  if (!receiverRunning) {
    console.log('- Start the local receiver: npm run workspace:openclaw-receiver')
  }
  if (!liveSyncInstalled) {
    console.log('- Install background sync: npm run workspace:openclaw-live:install')
  }
  console.log('- Send a quick proof: node /Users/tobik/.openclaw/workspace/skills/beam-protocol/beam-send.js --agent archivar --to echo@beam.directory --intent conversation.message --payload \'{"message":"Ping from OpenClaw through Beam."}\' --timeout 30')
  console.log('')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
