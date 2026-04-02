import { copyFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { optionalFlag, requestJson } from '../production/shared.mjs'
import { loadOpenClawRuntimeState, openClawRouteKeyForDescriptor } from './openclaw-runtime-state.mjs'
import {
  loadOpenClawAdminSession,
  loadOpenClawHostConnectorState,
  storeOpenClawAdminSession,
  storeOpenClawHostConnectorState,
} from './openclaw-secret-store.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const packageJsonPath = path.join(repoRoot, 'package.json')
const composeFile = path.join(repoRoot, 'ops/quickstart/compose.yaml')
const envPath = path.join(repoRoot, 'ops/quickstart/.env')
const envExamplePath = path.join(repoRoot, 'ops/quickstart/.env.example')
const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run'

const directoryUrl = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL || 'http://localhost:43100')
const dashboardUrl = optionalFlag('--dashboard-url', process.env.BEAM_DASHBOARD_URL || 'http://localhost:43173')
const adminEmail = optionalFlag('--email', process.env.BEAM_ADMIN_EMAIL || 'ops@beam.local')
const workspaceSlug = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG || 'openclaw-local')
const hostLabelOverride = optionalFlag('--host-label', process.env.BEAM_OPENCLAW_HOST_LABEL || null)
const enrollmentTokenOverride = optionalFlag('--enrollment-token', process.env.BEAM_OPENCLAW_ENROLLMENT_TOKEN || null)
const syncIntervalMs = Number.parseInt(optionalFlag('--sync-interval-ms', '10000'), 10)
const heartbeatIntervalMs = Number.parseInt(optionalFlag('--heartbeat-interval-ms', '10000'), 10)
const autoApprove = process.argv.includes('--auto-approve')
const rebuildStack = process.argv.includes('--rebuild')
const statePath = optionalFlag('--state-path', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-openclaw-host.json'))
const sessionCachePath = optionalFlag('--admin-session-cache', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-admin-session.json'))

const nodePath = process.execPath
const dockerPath = fs.existsSync('/opt/homebrew/bin/docker')
  ? '/opt/homebrew/bin/docker'
  : fs.existsSync('/usr/local/bin/docker')
    ? '/usr/local/bin/docker'
    : 'docker'

function log(message) {
  console.log(`[beam-openclaw-host] ${message}`)
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function normalizeHostState(state) {
  if (!state || typeof state !== 'object') {
    return {}
  }
  return state
}

function isLocalDirectory(targetUrl) {
  return /:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/u.test(targetUrl)
}

function run(commandName, args, { allowFailure = false, cwd = repoRoot, env = process.env } = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    stdio: 'inherit',
    env,
  })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${commandName} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
  return result
}

async function ensureQuickstartEnv() {
  if (!fs.existsSync(envPath)) {
    await copyFile(envExamplePath, envPath)
    log('created ops/quickstart/.env from .env.example')
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
  if (!isLocalDirectory(directoryUrl)) {
    return
  }

  await ensureQuickstartEnv()

  if (rebuildStack) {
    log('rebuilding the local Beam quickstart stack with docker compose')
    run(dockerPath, ['compose', '-f', composeFile, '--env-file', envPath, 'up', '-d', '--build'])
    return
  }

  const [directoryOk, dashboardOk] = await Promise.all([
    isHealthy(`${directoryUrl}/health`),
    isHealthy(dashboardUrl),
  ])

  if (directoryOk && dashboardOk) {
    log('local Beam stack already looks healthy')
    return
  }

  log('starting the local Beam quickstart stack with docker compose')
  run(dockerPath, ['compose', '-f', composeFile, '--env-file', envPath, 'up', '-d', '--build'])
}

async function requestJsonAllow(url, init, allowedStatuses = []) {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return { status: response.status, payload }
}

function createAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
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

  const session = {
    token: verify.token,
    url: challenge.url,
    createdAt: Date.now(),
    email: adminEmail,
  }
  await storeOpenClawAdminSession(sessionCachePath, session)
  return session
}

async function getAdminSession({ force = false } = {}) {
  if (!force) {
    const cached = await loadOpenClawAdminSession(sessionCachePath)
    if (cached && typeof cached.token === 'string' && typeof cached.createdAt === 'number') {
      const maxAgeMs = 6 * 60 * 60 * 1000
      if ((Date.now() - cached.createdAt) < maxAgeMs) {
        return cached
      }
    }
  }

  return createAdminSession()
}

function buildHostMetadata(state = {}) {
  return {
    label: hostLabelOverride || state.label || os.hostname(),
    hostname: os.hostname(),
    os: `${process.platform} ${os.release()}`,
    connectorVersion: readPackageVersion(),
    beamDirectoryUrl: directoryUrl,
    workspaceSlug,
    metadata: {
      controlPlane: 'beam-openclaw-host',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workspaceSlug,
    },
  }
}

async function persistHostState(nextState) {
  await storeOpenClawHostConnectorState(statePath, nextState)
  return nextState
}

function createHostHeaders(credential) {
  return {
    Authorization: `Bearer ${credential}`,
    'Content-Type': 'application/json',
  }
}

async function issueEnrollment(adminSession) {
  const response = await requestJson(`${directoryUrl}/admin/openclaw/hosts/enrollment`, {
    method: 'POST',
    headers: createAdminHeaders(adminSession.token),
    body: JSON.stringify({
      label: buildHostMetadata().label,
      workspaceSlug,
      notes: `Issued by ${adminEmail} for ${os.hostname()}`,
      expiresInHours: 72,
    }),
  })
  return response.enrollment
}

async function enrollHost(state) {
  const enrollmentToken = enrollmentTokenOverride || state.enrollmentToken
  if (!enrollmentToken) {
    throw new Error('No OpenClaw host enrollment token is available. Supply --enrollment-token or run setup with admin access.')
  }

  const metadata = buildHostMetadata(state)
  const response = await requestJsonAllow(`${directoryUrl}/openclaw/hosts/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: enrollmentToken,
      label: metadata.label,
      hostname: metadata.hostname,
      os: metadata.os,
      connectorVersion: metadata.connectorVersion,
      beamDirectoryUrl: metadata.beamDirectoryUrl,
      workspaceSlug: metadata.workspaceSlug,
      metadata: metadata.metadata,
    }),
  }, [202])

  const host = response.payload?.host ?? null
  const enrollment = response.payload?.enrollment ?? null
  const nextState = {
    ...state,
    label: host?.label ?? metadata.label,
    workspaceSlug: host?.workspaceSlug ?? workspaceSlug,
    hostId: host?.id ?? state.hostId ?? null,
    hostKey: host?.hostKey ?? state.hostKey ?? null,
    enrollmentId: enrollment?.id ?? state.enrollmentId ?? null,
    enrollmentToken,
    enrollmentStatus: enrollment?.status ?? state.enrollmentStatus ?? 'pending',
    credential: response.payload?.credential ?? state.credential ?? null,
    status: host?.status ?? state.status ?? 'pending',
    healthStatus: host?.healthStatus ?? state.healthStatus ?? 'pending',
    approvedAt: host?.approvedAt ?? state.approvedAt ?? null,
    approvedBy: host?.approvedBy ?? state.approvedBy ?? null,
    revokedAt: host?.revokedAt ?? state.revokedAt ?? null,
    revocationReason: host?.revocationReason ?? state.revocationReason ?? null,
    updatedAt: new Date().toISOString(),
  }

  return persistHostState(nextState)
}

async function approveHost(state, adminSession) {
  if (!state.hostId) {
    return state
  }

  const response = await requestJson(`${directoryUrl}/admin/openclaw/hosts/${state.hostId}/approve`, {
    method: 'POST',
    headers: createAdminHeaders(adminSession.token),
  })

  return persistHostState({
    ...state,
    credential: response.credential,
    status: response.host.status,
    healthStatus: response.host.healthStatus,
    approvedAt: response.host.approvedAt,
    approvedBy: response.host.approvedBy,
    revokedAt: response.host.revokedAt,
    revocationReason: response.host.revocationReason,
    updatedAt: new Date().toISOString(),
  })
}

async function ensureHostCredential(initialState, { allowBootstrapAdmin = false, allowAutoApprove = false } = {}) {
  let state = normalizeHostState(initialState)

  if (state.credential && state.hostKey) {
    return state
  }

  if (!state.enrollmentToken && allowBootstrapAdmin) {
    const adminSession = await getAdminSession()
    const enrollment = await issueEnrollment(adminSession)
    state = await persistHostState({
      ...state,
      enrollmentId: enrollment.id,
      enrollmentToken: enrollment.token,
      enrollmentStatus: enrollment.status,
      label: enrollment.label ?? state.label ?? buildHostMetadata().label,
      workspaceSlug: enrollment.workspaceSlug ?? state.workspaceSlug ?? workspaceSlug,
      updatedAt: new Date().toISOString(),
    })
  }

  state = await enrollHost(state)

  if (!state.credential && allowAutoApprove && state.hostId) {
    const adminSession = await getAdminSession()
    state = await approveHost(state, adminSession)
  }

  return state
}

function mapRouteToInventoryEntry(route) {
  const routeSource = route.source
  const routeKey = openClawRouteKeyForDescriptor(route)

  const metadata = {
    identityKey: route.identityKey,
    agentName: route.agentName,
    source: route.source,
    role: route.role ?? null,
    controllerAgent: route.controllerAgent ?? null,
    label: route.label ?? null,
    runId: route.runId ?? null,
    taskPreview: route.taskPreview ?? null,
  }

  return {
    beamId: route.beamId,
    workspaceSlug,
    routeSource,
    routeKey,
    runtimeType: route.runtimeType ?? null,
    label: route.displayName ?? route.label ?? route.agentName,
    connectionMode: 'websocket',
    httpEndpoint: null,
    sessionKey: route.childSessionKey ?? null,
    reportedState: route.endedAt ? 'ended' : 'live',
    metadata,
    lastSeenAt: new Date().toISOString(),
    endedAt: typeof route.endedAt === 'number' ? new Date(route.endedAt).toISOString() : null,
  }
}

async function syncHostInventory(state) {
  if (!state.credential) {
    return { routeCount: 0, runtime: null }
  }

  const runtime = await loadOpenClawRuntimeState({
    includeEndedSubagents: true,
  })
  const routes = runtime.routes.map((route) => mapRouteToInventoryEntry(route))

  await requestJson(`${directoryUrl}/openclaw/hosts/inventory`, {
    method: 'POST',
    headers: createHostHeaders(state.credential),
    body: JSON.stringify({
      connectorVersion: readPackageVersion(),
      beamDirectoryUrl: directoryUrl,
      workspaceSlug,
      label: buildHostMetadata(state).label,
      hostname: os.hostname(),
      os: `${process.platform} ${os.release()}`,
      routes,
    }),
  })

  return {
    routeCount: routes.length,
    runtime,
  }
}

async function heartbeatHost(state, routeCount) {
  if (!state.credential) {
    return null
  }

  const response = await requestJson(`${directoryUrl}/openclaw/hosts/heartbeat`, {
    method: 'POST',
    headers: createHostHeaders(state.credential),
    body: JSON.stringify({
      routeCount,
      connectorVersion: readPackageVersion(),
      details: {
        pid: process.pid,
        hostname: os.hostname(),
      },
    }),
  })

  return response
}

function startReceiverChild(state) {
  const child = spawn(nodePath, [path.join(repoRoot, 'scripts/workspace/openclaw-beam-receiver.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BEAM_DIRECTORY_URL: directoryUrl,
      BEAM_WORKSPACE_SLUG: workspaceSlug,
      BEAM_OPENCLAW_HOST_CREDENTIAL: state.credential ?? '',
      BEAM_OPENCLAW_HOST_STATE_PATH: statePath,
    },
    stdio: 'inherit',
  })

  return child
}

async function setupCommand() {
  await ensureLocalStack()

  if (isLocalDirectory(directoryUrl)) {
    log('running local quickstart smoke')
    run(nodePath, [path.join(repoRoot, 'scripts/quickstart/smoke.mjs')])
  }

  log('importing OpenClaw identities into Beam')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/import-openclaw.mjs'), '--register-missing'])

  log('installing Beam send shim')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/install-openclaw-beam-send-shim.mjs')])

  log('installing direct OpenClaw spawn hook')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/install-openclaw-spawn-hook.mjs')])

  let state = await loadOpenClawHostConnectorState(statePath)
  state = await ensureHostCredential(state, {
    allowBootstrapAdmin: true,
    allowAutoApprove: autoApprove || isLocalDirectory(directoryUrl),
  })

  if (!state.credential) {
    log('host is enrolled but still waiting for manual approval')
  } else {
    log(`host approved: ${state.hostKey}`)
  }

  let loginUrl = null
  try {
    const adminSession = await getAdminSession()
    loginUrl = adminSession.url ?? null
  } catch {
    loginUrl = null
  }

  console.log('')
  console.log('Beam OpenClaw host setup finished.')
  if (loginUrl) {
    console.log(`Login:     ${loginUrl}`)
  }
  console.log(`Workspace: ${dashboardUrl}/workspaces?workspace=${encodeURIComponent(workspaceSlug)}`)
  console.log(`Fleet:     ${dashboardUrl}/openclaw-fleet`)
  if (!state.credential) {
    console.log('Status:    waiting for manual host approval')
    console.log(`Host key:  ${state.hostKey ?? 'pending'}`)
  } else {
    console.log(`Host key:  ${state.hostKey}`)
    console.log('Status:    host credential issued and ready')
  }
}

async function statusCommand() {
  const state = normalizeHostState(await loadOpenClawHostConnectorState(statePath))
  const runtime = await loadOpenClawRuntimeState({ includeEndedSubagents: true })

  let fleetHost = null
  let adminSession = null
  try {
    adminSession = await getAdminSession()
    if (state.hostId) {
      const detail = await requestJson(`${directoryUrl}/admin/openclaw/hosts/${state.hostId}`, {
        headers: { Authorization: `Bearer ${adminSession.token}` },
      })
      fleetHost = detail.host
    }
  } catch {
    fleetHost = null
  }

  console.log('')
  console.log('Beam OpenClaw host status')
  console.log('')
  if (adminSession?.url) {
    console.log(`Login:           ${adminSession.url}`)
  }
  console.log(`Workspace:       ${dashboardUrl}/workspaces?workspace=${encodeURIComponent(workspaceSlug)}`)
  console.log(`OpenClaw Fleet:  ${dashboardUrl}/openclaw-fleet${state.hostId ? `?host=${state.hostId}` : ''}`)
  console.log('')
  console.log('Host connector')
  console.log(`- host key:         ${state.hostKey ?? 'not enrolled'}`)
  console.log(`- label:            ${state.label ?? buildHostMetadata().label}`)
  console.log(`- credential:       ${state.credential ? 'present' : 'missing'}`)
  console.log(`- enrollment:       ${state.enrollmentStatus ?? 'none'}`)
  console.log(`- approved at:      ${state.approvedAt ?? 'pending'}`)
  console.log(`- revoked at:       ${state.revokedAt ?? 'no'}`)
  if (fleetHost) {
    console.log(`- fleet health:     ${fleetHost.healthStatus}`)
    console.log(`- route count:      ${fleetHost.routeCount}`)
    console.log(`- last heartbeat:   ${fleetHost.lastHeartbeatAt ?? 'never'}`)
  }
  console.log('')
  console.log('Runtime discovery')
  console.log(`- persistent:       ${runtime.counts.persistentAgents}`)
  console.log(`- workspace agents: ${runtime.counts.workspaceAgents}`)
  console.log(`- gateway agents:   ${runtime.counts.gatewayAgents}`)
  console.log(`- subagents:        ${runtime.counts.subagents}`)
  console.log(`- total routes:     ${runtime.routes.length}`)
  console.log('')
}

async function runCommand() {
  let state = await loadOpenClawHostConnectorState(statePath)
  state = await ensureHostCredential(state, {
    allowBootstrapAdmin: isLocalDirectory(directoryUrl),
    allowAutoApprove: autoApprove || isLocalDirectory(directoryUrl),
  })

  let receiver = startReceiverChild(state)
  let lastHeartbeat = 0

  const stopReceiver = async () => {
    if (!receiver || receiver.exitCode !== null) {
      return
    }
    receiver.kill('SIGTERM')
    await sleep(500)
    if (receiver.exitCode === null) {
      receiver.kill('SIGKILL')
    }
  }

  const shutdown = async () => {
    await stopReceiver()
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })

  log(`running Beam OpenClaw host for ${state.label ?? buildHostMetadata().label}`)

  while (true) {
    try {
      if (!receiver || receiver.exitCode !== null) {
        receiver = startReceiverChild(state)
      }

      if (!state.credential) {
        state = await ensureHostCredential(state, {
          allowBootstrapAdmin: false,
          allowAutoApprove: false,
        })
      }

      if (state.credential) {
        const inventory = await syncHostInventory(state)
        if ((Date.now() - lastHeartbeat) >= heartbeatIntervalMs) {
          await heartbeatHost(state, inventory.routeCount)
          lastHeartbeat = Date.now()
        }
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }

    await sleep(syncIntervalMs)
  }
}

switch (command) {
  case 'setup':
    await setupCommand()
    break
  case 'status':
    await statusCommand()
    break
  case 'run':
    await runCommand()
    break
  default:
    console.error(`Unknown beam-openclaw-host command: ${command}`)
    process.exit(1)
}
