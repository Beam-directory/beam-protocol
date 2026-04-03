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

const directoryUrlFlag = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL || null)
const dashboardUrlFlag = optionalFlag('--dashboard-url', process.env.BEAM_DASHBOARD_URL || null)
const adminEmailFlag = optionalFlag('--email', process.env.BEAM_ADMIN_EMAIL || null)
const workspaceSlugFlag = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG || null)
const hostLabelOverrideFlag = optionalFlag('--host-label', process.env.BEAM_OPENCLAW_HOST_LABEL || null)
const enrollmentTokenOverride = optionalFlag('--enrollment-token', process.env.BEAM_OPENCLAW_ENROLLMENT_TOKEN || null)
const syncIntervalMs = Number.parseInt(optionalFlag('--sync-interval-ms', '10000'), 10)
const heartbeatIntervalMs = Number.parseInt(optionalFlag('--heartbeat-interval-ms', '10000'), 10)
const autoApprove = process.argv.includes('--auto-approve')
const rebuildStack = process.argv.includes('--rebuild')
const jsonOutput = process.argv.includes('--json')
const statePath = optionalFlag('--state-path', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-openclaw-host.json'))
const sessionCachePath = optionalFlag('--admin-session-cache', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-admin-session.json'))
const credentialOverrideFlag = optionalFlag('--credential', null)

const nodePath = process.execPath
const hostAgentScriptPath = path.join(repoRoot, 'scripts/workspace/install-openclaw-host-agent.mjs')
const dockerPath = fs.existsSync('/opt/homebrew/bin/docker')
  ? '/opt/homebrew/bin/docker'
  : fs.existsSync('/usr/local/bin/docker')
    ? '/usr/local/bin/docker'
    : 'docker'
const inventoryPayloadSoftLimitBytes = 48 * 1024

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

function resolveConfig(state) {
  const resolvedState = normalizeHostState(state)
  return {
    directoryUrl: directoryUrlFlag || resolvedState.directoryUrl || 'http://localhost:43100',
    dashboardUrl: dashboardUrlFlag || resolvedState.dashboardUrl || 'http://localhost:43173',
    adminEmail: adminEmailFlag || resolvedState.adminEmail || 'ops@beam.local',
    workspaceSlug: workspaceSlugFlag || resolvedState.workspaceSlug || 'openclaw-local',
    hostLabel: hostLabelOverrideFlag || resolvedState.label || os.hostname(),
    enrollmentToken: enrollmentTokenOverride || resolvedState.enrollmentToken || null,
  }
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

async function getDirectoryReleaseVersion(directoryUrl) {
  try {
    const response = await fetch(`${directoryUrl}/release`)
    if (!response.ok) {
      return null
    }
    const payload = await response.json()
    const version = payload?.release?.version
    const gitSha = payload?.release?.gitSha
    return {
      version: typeof version === 'string' && version.length > 0 ? version : null,
      gitSha: typeof gitSha === 'string' && gitSha.length > 0 ? gitSha : null,
    }
  } catch {
    return null
  }
}

function readLocalGitSha() {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    return null
  }

  const sha = result.stdout.trim()
  return /^[0-9a-f]{7,40}$/iu.test(sha) ? sha : null
}

async function hasOpenClawFleetApi(directoryUrl) {
  try {
    const response = await fetch(`${directoryUrl}/admin/openclaw/hosts`)
    return response.status !== 404
  } catch {
    return false
  }
}

async function rebuildLocalStack() {
  log('rebuilding the local Beam quickstart stack with docker compose')
  run(dockerPath, ['compose', '-f', composeFile, '--env-file', envPath, 'up', '-d', '--build'])
}

async function ensureLocalStack(config) {
  if (!isLocalDirectory(config.directoryUrl)) {
    return
  }

  await ensureQuickstartEnv()

  if (rebuildStack) {
    await rebuildLocalStack()
    return
  }

  const [directoryOk, dashboardOk] = await Promise.all([
    isHealthy(`${config.directoryUrl}/health`),
    isHealthy(config.dashboardUrl),
  ])

  if (directoryOk && dashboardOk) {
    const [releaseVersion, hasFleetApi] = await Promise.all([
      getDirectoryReleaseVersion(config.directoryUrl),
      hasOpenClawFleetApi(config.directoryUrl),
    ])
    const localVersion = readPackageVersion()
    const localGitSha = readLocalGitSha()

    if (!hasFleetApi) {
      log('local Beam stack is healthy but missing OpenClaw fleet APIs; rebuilding to the current repo state')
      await rebuildLocalStack()
      return
    }

    if (releaseVersion?.version && releaseVersion.version !== localVersion) {
      log(`local Beam stack reports version ${releaseVersion.version}, but the repo is ${localVersion}; rebuilding to the current repo state`)
      await rebuildLocalStack()
      return
    }

    if (releaseVersion?.gitSha && localGitSha && releaseVersion.gitSha !== localGitSha) {
      log(`local Beam stack reports git sha ${releaseVersion.gitSha.slice(0, 7)}, but the repo is ${localGitSha.slice(0, 7)}; rebuilding to the current repo state`)
      await rebuildLocalStack()
      return
    }

    log('local Beam stack already looks healthy and up to date')
    return
  }

  log('starting the local Beam quickstart stack with docker compose')
  await rebuildLocalStack()
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

async function createAdminSession(config) {
  const challenge = await requestJson(`${config.directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: config.dashboardUrl,
    },
    body: JSON.stringify({ email: config.adminEmail }),
  })

  const verify = await requestJson(`${config.directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  const session = {
    token: verify.token,
    url: challenge.url,
    createdAt: Date.now(),
    email: config.adminEmail,
  }
  await storeOpenClawAdminSession(sessionCachePath, session)
  return session
}

async function getAdminSession(config, { force = false } = {}) {
  if (!force) {
    const cached = await loadOpenClawAdminSession(sessionCachePath)
    if (cached && typeof cached.token === 'string' && typeof cached.createdAt === 'number') {
      const maxAgeMs = 6 * 60 * 60 * 1000
      if ((Date.now() - cached.createdAt) < maxAgeMs) {
        return cached
      }
    }
  }

  return createAdminSession(config)
}

function buildHostMetadata(state = {}) {
  const config = resolveConfig(state)
  return {
    label: config.hostLabel,
    hostname: os.hostname(),
    os: `${process.platform} ${os.release()}`,
    connectorVersion: readPackageVersion(),
    beamDirectoryUrl: config.directoryUrl,
    workspaceSlug: config.workspaceSlug,
    metadata: {
      controlPlane: 'beam-openclaw-host',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workspaceSlug: config.workspaceSlug,
    },
  }
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') {
    return value ?? null
  }
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function compactObjectEntries(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined))
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

async function issueEnrollment(state, adminSession) {
  const config = resolveConfig(state)
  const response = await requestJson(`${config.directoryUrl}/admin/openclaw/hosts/enrollment`, {
    method: 'POST',
    headers: createAdminHeaders(adminSession.token),
    body: JSON.stringify({
      label: buildHostMetadata(state).label,
      workspaceSlug: config.workspaceSlug,
      notes: `Issued by ${config.adminEmail} for ${os.hostname()}`,
      expiresInHours: 72,
    }),
  })
  return response.enrollment
}

async function enrollHost(state) {
  const config = resolveConfig(state)
  const enrollmentToken = config.enrollmentToken
  if (!enrollmentToken) {
    throw new Error('No OpenClaw host enrollment token is available. Supply --enrollment-token or run setup with admin access.')
  }

  const metadata = buildHostMetadata(state)
  const response = await requestJsonAllow(`${config.directoryUrl}/openclaw/hosts/enroll`, {
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
    hostId: host?.id ?? state.hostId ?? null,
    hostKey: host?.hostKey ?? state.hostKey ?? null,
    enrollmentId: enrollment?.id ?? state.enrollmentId ?? null,
    enrollmentToken,
    enrollmentStatus: enrollment?.status ?? state.enrollmentStatus ?? 'pending',
    credential: response.payload?.credential ?? state.credential ?? null,
    status: host?.status ?? state.status ?? 'pending',
    healthStatus: host?.healthStatus ?? state.healthStatus ?? 'pending',
    directoryUrl: config.directoryUrl,
    dashboardUrl: config.dashboardUrl,
    adminEmail: config.adminEmail,
    workspaceSlug: host?.workspaceSlug ?? state.workspaceSlug ?? config.workspaceSlug,
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

  const config = resolveConfig(state)
  const response = await requestJson(`${config.directoryUrl}/admin/openclaw/hosts/${state.hostId}/approve`, {
    method: 'POST',
    headers: createAdminHeaders(adminSession.token),
  })

  return persistHostState({
    ...state,
    credential: response.credential,
    enrollmentStatus: response.host.status === 'approved' ? 'approved' : state.enrollmentStatus,
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
    const config = resolveConfig(state)
    const adminSession = await getAdminSession(config)
    const enrollment = await issueEnrollment(state, adminSession)
    state = await persistHostState({
      ...state,
      enrollmentId: enrollment.id,
      enrollmentToken: enrollment.token,
      enrollmentStatus: enrollment.status,
      label: enrollment.label ?? state.label ?? buildHostMetadata(state).label,
      directoryUrl: config.directoryUrl,
      dashboardUrl: config.dashboardUrl,
      adminEmail: config.adminEmail,
      workspaceSlug: enrollment.workspaceSlug ?? state.workspaceSlug ?? config.workspaceSlug,
      updatedAt: new Date().toISOString(),
    })
  }

  state = await enrollHost(state)

  if (!state.credential && allowAutoApprove && state.hostId) {
    const adminSession = await getAdminSession(resolveConfig(state))
    state = await approveHost(state, adminSession)
  }

  return state
}

function mapRouteToInventoryEntry(route, config, strategy = 'full') {
  const routeSource = route.source
  const routeKey = openClawRouteKeyForDescriptor(route)
  const metadata =
    strategy === 'minimal'
      ? compactObjectEntries([
          ['agentName', truncateText(route.agentName, 96)],
          ['source', route.source],
        ])
      : strategy === 'compact'
        ? compactObjectEntries([
            ['identityKey', truncateText(route.identityKey, 96)],
            ['agentName', truncateText(route.agentName, 96)],
            ['source', route.source],
            ['role', truncateText(route.role ?? null, 64)],
            ['runId', truncateText(route.runId ?? null, 96)],
            ['taskPreview', truncateText(route.taskPreview ?? null, 120)],
          ])
        : compactObjectEntries([
            ['identityKey', truncateText(route.identityKey, 120)],
            ['agentName', truncateText(route.agentName, 120)],
            ['source', route.source],
            ['role', truncateText(route.role ?? null, 80)],
            ['controllerAgent', truncateText(route.controllerAgent ?? null, 120)],
            ['label', truncateText(route.label ?? null, 140)],
            ['runId', truncateText(route.runId ?? null, 120)],
            ['taskPreview', truncateText(route.taskPreview ?? null, 240)],
          ])

  return {
    beamId: route.beamId,
    workspaceSlug: config.workspaceSlug,
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

function buildInventoryPayload(config, routes) {
  return {
    connectorVersion: readPackageVersion(),
    beamDirectoryUrl: config.directoryUrl,
    workspaceSlug: config.workspaceSlug,
    label: buildHostMetadata(config).label,
    hostname: os.hostname(),
    os: `${process.platform} ${os.release()}`,
    routes,
  }
}

async function syncHostInventory(state) {
  if (!state.credential) {
    return { routeCount: 0, runtime: null }
  }

  const config = resolveConfig(state)
  const runtime = await loadOpenClawRuntimeState({
    includeEndedSubagents: true,
  })
  const routeStrategies = ['full', 'compact', 'minimal']
  let routes = []
  let payload = null
  let selectedStrategy = 'full'

  for (const strategy of routeStrategies) {
    const candidateRoutes = runtime.routes.map((route) => mapRouteToInventoryEntry(route, config, strategy))
    const candidatePayload = buildInventoryPayload(config, candidateRoutes)
    const serializedSize = Buffer.byteLength(JSON.stringify(candidatePayload), 'utf8')
    routes = candidateRoutes
    payload = candidatePayload
    selectedStrategy = strategy
    if (serializedSize <= inventoryPayloadSoftLimitBytes || strategy === 'minimal') {
      if (strategy !== 'full') {
        log(`inventory payload exceeded the soft limit; using ${strategy} inventory metadata for ${candidateRoutes.length} routes`)
      }
      break
    }
  }

  await requestJson(`${config.directoryUrl}/openclaw/hosts/inventory`, {
    method: 'POST',
    headers: createHostHeaders(state.credential),
    body: JSON.stringify(payload),
  })

  return {
    routeCount: routes.length,
    runtime,
    inventoryStrategy: selectedStrategy,
  }
}

async function heartbeatHost(state, routeCount) {
  if (!state.credential) {
    return null
  }

  const config = resolveConfig(state)
  const response = await requestJson(`${config.directoryUrl}/openclaw/hosts/heartbeat`, {
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
  const config = resolveConfig(state)
  const child = spawn(nodePath, [path.join(repoRoot, 'scripts/workspace/openclaw-beam-receiver.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BEAM_DIRECTORY_URL: config.directoryUrl,
      BEAM_WORKSPACE_SLUG: config.workspaceSlug,
      BEAM_OPENCLAW_HOST_CREDENTIAL: state.credential ?? '',
      BEAM_OPENCLAW_HOST_STATE_PATH: statePath,
    },
    stdio: 'inherit',
  })

  return child
}

function serviceCommandArgs(extraArgs = []) {
  return [
    hostAgentScriptPath,
    ...extraArgs,
    '--state-path',
    statePath,
    '--admin-session-cache',
    sessionCachePath,
  ]
}

function readManagedServiceStatus() {
  const result = spawnSync(nodePath, serviceCommandArgs(['--status', '--json']), {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    throw new Error(stderr || `Unable to inspect Beam OpenClaw host service (status ${result.status ?? 'unknown'})`)
  }

  return JSON.parse(result.stdout || '{}')
}

function installManagedService() {
  run(nodePath, serviceCommandArgs())
}

function uninstallManagedService() {
  run(nodePath, serviceCommandArgs(['--uninstall']))
}

async function setupCommand() {
  const initialState = await loadOpenClawHostConnectorState(statePath)
  const config = resolveConfig(initialState)
  await ensureLocalStack(config)

  if (isLocalDirectory(config.directoryUrl)) {
    log('running local quickstart smoke')
    run(nodePath, [path.join(repoRoot, 'scripts/quickstart/smoke.mjs')])
  }

  log('importing OpenClaw identities into Beam')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/import-openclaw.mjs'), '--register-missing'])

  log('installing Beam send shim')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/install-openclaw-beam-send-shim.mjs')])

  log('installing direct OpenClaw spawn hook')
  run(nodePath, [path.join(repoRoot, 'scripts/workspace/install-openclaw-spawn-hook.mjs')])

  let state = await persistHostState({
    ...normalizeHostState(initialState),
    directoryUrl: config.directoryUrl,
    dashboardUrl: config.dashboardUrl,
    adminEmail: config.adminEmail,
    workspaceSlug: config.workspaceSlug,
    label: config.hostLabel,
    enrollmentToken: config.enrollmentToken,
    updatedAt: new Date().toISOString(),
  })
  try {
    state = await ensureHostCredential(state, {
      allowBootstrapAdmin: true,
      allowAutoApprove: autoApprove || isLocalDirectory(config.directoryUrl),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const shouldRetryLocalSetup =
      isLocalDirectory(config.directoryUrl) &&
      /admin\/openclaw\/hosts\/enrollment/u.test(message) &&
      /404/u.test(message)

    if (!shouldRetryLocalSetup) {
      throw error
    }

    log('local Beam stack answered without the OpenClaw enrollment route; rebuilding once and retrying setup')
    await rebuildLocalStack()
    log('rerunning local quickstart smoke after the rebuild')
    run(nodePath, [path.join(repoRoot, 'scripts/quickstart/smoke.mjs')])
    state = await ensureHostCredential(state, {
      allowBootstrapAdmin: true,
      allowAutoApprove: autoApprove || isLocalDirectory(config.directoryUrl),
    })
  }

  log('installing managed Beam OpenClaw host service')
  installManagedService()

  if (!state.credential) {
    log('host is enrolled but still waiting for manual approval')
  } else {
    log(`host approved: ${state.hostKey}`)
  }

  let loginUrl = null
  try {
    const adminSession = await getAdminSession(resolveConfig(state))
    loginUrl = adminSession.url ?? null
  } catch {
    loginUrl = null
  }

  const resolvedConfig = resolveConfig(state)

  console.log('')
  console.log('Beam OpenClaw host setup finished.')
  if (loginUrl) {
    console.log(`Login:     ${loginUrl}`)
  }
  console.log(`Workspace: ${resolvedConfig.dashboardUrl}/workspaces?workspace=${encodeURIComponent(resolvedConfig.workspaceSlug)}`)
  console.log(`Fleet:     ${resolvedConfig.dashboardUrl}/openclaw-fleet`)
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
  const config = resolveConfig(state)
  const runtime = await loadOpenClawRuntimeState({ includeEndedSubagents: true })

  let fleetHost = null
  let adminSession = null
  let serviceStatus = null
  try {
    adminSession = await getAdminSession(config)
    if (state.hostId) {
      const detail = await requestJson(`${config.directoryUrl}/admin/openclaw/hosts/${state.hostId}`, {
        headers: { Authorization: `Bearer ${adminSession.token}` },
      })
      fleetHost = detail.host
    }
  } catch {
    fleetHost = null
  }
  try {
    serviceStatus = readManagedServiceStatus()
  } catch {
    serviceStatus = null
  }

  if (jsonOutput) {
    const payload = {
      loginUrl: adminSession?.url ?? null,
      workspaceUrl: `${config.dashboardUrl}/workspaces?workspace=${encodeURIComponent(config.workspaceSlug)}`,
      fleetUrl: `${config.dashboardUrl}/openclaw-fleet${state.hostId ? `?host=${state.hostId}` : ''}`,
      host: {
        hostId: state.hostId ?? null,
        hostKey: state.hostKey ?? null,
        label: state.label ?? buildHostMetadata(state).label,
        credentialPresent: Boolean(state.credential),
        credentialStore: state.credentialStorage ?? 'unknown',
        enrollment: fleetHost?.status ?? state.status ?? state.enrollmentStatus ?? 'none',
        approvedAt: state.approvedAt ?? null,
        revokedAt: state.revokedAt ?? null,
        fleetHealth: fleetHost?.healthStatus ?? null,
        routeCount: fleetHost?.routeCount ?? null,
        lastHeartbeatAt: fleetHost?.lastHeartbeatAt ?? null,
      },
      service: serviceStatus
        ? {
            label: serviceStatus.serviceLabel ?? 'beam-openclaw-host',
            installed: Boolean(serviceStatus.installed),
            running: Boolean(serviceStatus.running),
            enabled: typeof serviceStatus.enabled === 'boolean' ? serviceStatus.enabled : null,
            activeState: typeof serviceStatus.activeState === 'string' ? serviceStatus.activeState : null,
            subState: typeof serviceStatus.subState === 'string' ? serviceStatus.subState : null,
          }
        : null,
      runtime: {
        persistent: runtime.counts.persistentAgents,
        workspaceAgents: runtime.counts.workspaceAgents,
        gatewayAgents: runtime.counts.gatewayAgents,
        subagents: runtime.counts.subagents,
        totalRoutes: runtime.routes.length,
      },
      ready: Boolean(state.credential) && (fleetHost?.healthStatus ?? state.healthStatus ?? null) === 'healthy',
    }

    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log('')
  console.log('Beam OpenClaw host status')
  console.log('')
  if (adminSession?.url) {
    console.log(`Login:           ${adminSession.url}`)
  }
  console.log(`Workspace:       ${config.dashboardUrl}/workspaces?workspace=${encodeURIComponent(config.workspaceSlug)}`)
  console.log(`OpenClaw Fleet:  ${config.dashboardUrl}/openclaw-fleet${state.hostId ? `?host=${state.hostId}` : ''}`)
  console.log('')
  console.log('Host connector')
  console.log(`- host key:         ${state.hostKey ?? 'not enrolled'}`)
  console.log(`- label:            ${state.label ?? buildHostMetadata(state).label}`)
  console.log(`- credential:       ${state.credential ? 'present' : 'missing'}`)
  console.log(`- credential store: ${state.credentialStorage ?? 'unknown'}`)
  console.log(`- enrollment:       ${fleetHost?.status ?? state.status ?? state.enrollmentStatus ?? 'none'}`)
  console.log(`- approved at:      ${state.approvedAt ?? 'pending'}`)
  console.log(`- revoked at:       ${state.revokedAt ?? 'no'}`)
  if (fleetHost) {
    console.log(`- fleet health:     ${fleetHost.healthStatus}`)
    console.log(`- route count:      ${fleetHost.routeCount}`)
    console.log(`- last heartbeat:   ${fleetHost.lastHeartbeatAt ?? 'never'}`)
  }
  if (serviceStatus) {
    console.log(`- service:          ${serviceStatus.serviceLabel ?? 'beam-openclaw-host'}`)
    console.log(`- service installed:${serviceStatus.installed ? ' yes' : ' no'}`)
    console.log(`- service running:  ${serviceStatus.running ? 'yes' : 'no'}`)
    if (typeof serviceStatus.enabled === 'boolean') {
      console.log(`- service enabled:  ${serviceStatus.enabled ? 'yes' : 'no'}`)
    }
    if (typeof serviceStatus.activeState === 'string') {
      console.log(`- service state:    ${serviceStatus.activeState}${serviceStatus.subState ? ` (${serviceStatus.subState})` : ''}`)
    }
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

async function installCommand() {
  let state = normalizeHostState(await loadOpenClawHostConnectorState(statePath))
  const config = resolveConfig(state)
  state = await persistHostState({
    ...state,
    directoryUrl: config.directoryUrl,
    dashboardUrl: config.dashboardUrl,
    adminEmail: config.adminEmail,
    workspaceSlug: config.workspaceSlug,
    label: config.hostLabel,
    enrollmentToken: config.enrollmentToken,
    updatedAt: new Date().toISOString(),
  })

  if (isLocalDirectory(config.directoryUrl)) {
    await ensureLocalStack(config)
  }

  state = await ensureHostCredential(state, {
    allowBootstrapAdmin: isLocalDirectory(config.directoryUrl),
    allowAutoApprove: autoApprove || isLocalDirectory(config.directoryUrl),
  })

  installManagedService()

  console.log('')
  console.log('Beam OpenClaw host service installed.')
  console.log(`Workspace: ${config.dashboardUrl}/workspaces?workspace=${encodeURIComponent(config.workspaceSlug)}`)
  console.log(`Fleet:     ${config.dashboardUrl}/openclaw-fleet${state.hostId ? `?host=${state.hostId}` : ''}`)
  console.log(`Host key:  ${state.hostKey ?? 'pending'}`)
  console.log(`Credential:${state.credential ? ' issued' : ' pending manual approval'}`)
}

async function uninstallCommand() {
  uninstallManagedService()
  console.log('')
  console.log('Beam OpenClaw host service removed.')
}

async function useCredentialCommand() {
  if (!credentialOverrideFlag) {
    throw new Error('Missing --credential for beam-openclaw-host use-credential')
  }

  const existing = normalizeHostState(await loadOpenClawHostConnectorState(statePath))
  const config = resolveConfig(existing)
  const nextState = {
    ...existing,
    credential: credentialOverrideFlag,
    directoryUrl: config.directoryUrl,
    dashboardUrl: config.dashboardUrl,
    adminEmail: config.adminEmail,
    workspaceSlug: config.workspaceSlug,
    label: config.hostLabel,
    updatedAt: new Date().toISOString(),
  }

  await persistHostState(nextState)

  try {
    const serviceStatus = readManagedServiceStatus()
    if (serviceStatus.installed) {
      installManagedService()
    }
  } catch {
    // Best-effort only; foreground mode can still pick up the new credential.
  }

  console.log('')
  console.log('Beam OpenClaw host credential updated.')
  console.log(`Workspace: ${config.dashboardUrl}/workspaces?workspace=${encodeURIComponent(config.workspaceSlug)}`)
  console.log(`Fleet:     ${config.dashboardUrl}/openclaw-fleet${nextState.hostId ? `?host=${nextState.hostId}` : ''}`)
}

async function runCommand() {
  let state = await loadOpenClawHostConnectorState(statePath)
  let config = resolveConfig(state)
  state = await ensureHostCredential(state, {
    allowBootstrapAdmin: isLocalDirectory(config.directoryUrl),
    allowAutoApprove: autoApprove || isLocalDirectory(config.directoryUrl),
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

  log(`running Beam OpenClaw host for ${state.label ?? buildHostMetadata(state).label}`)

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
        config = resolveConfig(state)
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
  case 'install':
    await installCommand()
    break
  case 'uninstall':
    await uninstallCommand()
    break
  case 'use-credential':
    await useCredentialCommand()
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
