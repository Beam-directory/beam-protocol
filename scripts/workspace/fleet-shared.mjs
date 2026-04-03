import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import {
  createAdminHeaders,
  loadDirectoryDbModule,
  repoRoot,
  requestJson,
  startProductionHarness,
} from '../production/shared.mjs'

const defaultConnectorVersion = '1.6.0-test'
const directoryAdminAuthEntry = path.join(repoRoot, 'packages/directory/dist/admin-auth.js')

function createFixtureAgent(beamId, displayName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    beamId,
    displayName,
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

async function loadDirectoryAdminAuthModule() {
  return import(pathToFileURL(directoryAdminAuthEntry).href)
}

async function createHarnessRoleToken(directoryDbPath, email, role, jwtSecret) {
  const [dbApi, adminAuthApi] = await Promise.all([
    loadDirectoryDbModule(),
    loadDirectoryAdminAuthModule(),
  ])
  const db = dbApi.createDatabase(directoryDbPath)
  const previousJwtSecret = process.env['JWT_SECRET']
  try {
    process.env['JWT_SECRET'] = jwtSecret
    const { token } = adminAuthApi.createAdminSession(db, { email, role })
    return token
  } finally {
    if (typeof previousJwtSecret === 'string') {
      process.env['JWT_SECRET'] = previousJwtSecret
    } else {
      delete process.env['JWT_SECRET']
    }
    db.close()
  }
}

function createSignedIntent(agent, to, payload, options = {}) {
  const frame = {
    v: '1',
    from: agent.beamId,
    to,
    intent: options.intent ?? 'conversation.message',
    payload,
    nonce: options.nonce ?? randomUUID(),
    timestamp: options.timestamp ?? new Date().toISOString(),
  }

  const signed = sign(
    null,
    Buffer.from(JSON.stringify({
      type: 'intent',
      from: frame.from,
      to: frame.to,
      intent: frame.intent,
      payload: frame.payload,
      timestamp: frame.timestamp,
      nonce: frame.nonce,
    }), 'utf8'),
    agent.privateKey,
  ).toString('base64')

  return {
    ...frame,
    signature: signed,
  }
}

async function requestJsonAllow(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload = null
  if (text.length > 0) {
    payload = JSON.parse(text)
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
  }
}

async function waitForJson(ws, timeoutMs = 10_000) {
  const timer = sleep(timeoutMs).then(() => {
    throw new Error(`Timed out waiting for a WebSocket message after ${timeoutMs}ms`)
  })
  const data = once(ws, 'message').then(([chunk]) => JSON.parse(Buffer.from(chunk).toString('utf8')))
  return Promise.race([data, timer])
}

export async function connectFleetClient(directoryUrl, beamId) {
  const wsUrl = directoryUrl.replace(/^http/u, 'ws') + `/ws?beamId=${encodeURIComponent(beamId)}`
  const ws = new WebSocket(wsUrl)
  await once(ws, 'open')
  await waitForJson(ws)
  return ws
}

export async function closeFleetClient(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return
  }
  ws.terminate()
  await once(ws, 'close').catch(() => undefined)
}

async function createOpenClawEnrollment(directoryUrl, token, input) {
  return requestJson(`${directoryUrl}/admin/openclaw/hosts/enrollment`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(input),
  })
}

async function enrollOpenClawHost(directoryUrl, enrollmentToken, input) {
  const response = await requestJsonAllow(`${directoryUrl}/openclaw/hosts/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: enrollmentToken,
      ...input,
    }),
  })
  if (!(response.status === 200 || response.status === 202)) {
    throw new Error(`OpenClaw host enroll failed with ${response.status}: ${JSON.stringify(response.payload)}`)
  }
  return response.payload
}

async function approveOpenClawHost(directoryUrl, token, hostId) {
  return requestJson(`${directoryUrl}/admin/openclaw/hosts/${hostId}/approve`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  })
}

function resolveConnectorVersion(details = {}) {
  return typeof details.connectorVersion === 'string' && details.connectorVersion.trim()
    ? details.connectorVersion.trim()
    : defaultConnectorVersion
}

export async function heartbeatOpenClawHost(directoryUrl, credential, routeCount, details = {}) {
  const connectorVersion = resolveConnectorVersion(details)
  const nextDetails = { ...details }
  delete nextDetails.connectorVersion

  return requestJson(`${directoryUrl}/openclaw/hosts/heartbeat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      routeCount,
      connectorVersion,
      details: nextDetails,
    }),
  })
}

export async function syncOpenClawInventory(directoryUrl, credential, host, routes) {
  return requestJson(`${directoryUrl}/openclaw/hosts/inventory`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connectorVersion: host.connectorVersion ?? defaultConnectorVersion,
      beamDirectoryUrl: directoryUrl,
      workspaceSlug: host.workspaceSlug,
      label: host.label,
      hostname: host.hostname,
      os: host.os,
      routes,
    }),
  })
}

export async function sendFleetIntent(directoryUrl, agent, to, payload, options = {}) {
  return requestJsonAllow(`${directoryUrl}/intents/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSignedIntent(agent, to, payload, options)),
  })
}

function buildRoute(host, agent, routeSource, suffix = 'primary') {
  return {
    beamId: agent.beamId,
    workspaceSlug: host.workspaceSlug,
    routeSource,
    routeKey: `${host.hostname}:${agent.beamId}:${suffix}`,
    runtimeType: `openclaw:${routeSource}`,
    label: agent.displayName,
    connectionMode: 'websocket',
    sessionKey: `${host.hostname}-${suffix}`,
    reportedState: 'live',
    metadata: {
      hostLabel: host.label,
      connector: 'beam-openclaw-host',
      routeSource,
    },
  }
}

function createFleetAgents() {
  return {
    alpha: createFixtureAgent('atlas@openclaw.beam.directory', 'Atlas'),
    beta: createFixtureAgent('beacon@openclaw.beam.directory', 'Beacon'),
    gamma: createFixtureAgent('cipher@openclaw.beam.directory', 'Cipher'),
  }
}

export async function startOpenClawFleetHarness() {
  const agents = createFleetAgents()
  const workspaceSlug = 'openclaw-local'
  const hostBlueprints = [
    {
      key: 'alpha',
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      os: 'macOS 14',
      workspaceSlug,
      routeSource: 'gateway-agent',
      agent: agents.alpha,
      connectorVersion: defaultConnectorVersion,
    },
    {
      key: 'beta',
      label: 'OpenClaw Host Beta',
      hostname: 'beta.local',
      os: 'Ubuntu 24.04',
      workspaceSlug,
      routeSource: 'workspace-agent',
      agent: agents.beta,
      connectorVersion: defaultConnectorVersion,
    },
    {
      key: 'gamma',
      label: 'OpenClaw Host Gamma',
      hostname: 'gamma.local',
      os: 'Debian 12',
      workspaceSlug,
      routeSource: 'subagent-run',
      agent: agents.gamma,
      connectorVersion: defaultConnectorVersion,
    },
  ]

  const harness = await startProductionHarness({
    withMessageBus: false,
    operatorEmails: 'ops@example.com',
    viewerEmails: 'viewer@example.com',
    seed: {
      directory(db, directoryDbApi) {
        for (const agent of Object.values(agents)) {
          directoryDbApi.registerAgent(db, {
            beamId: agent.beamId,
            displayName: agent.displayName,
            capabilities: ['conversation.message'],
            publicKey: agent.publicKey,
            verificationTier: 'business',
            email: `${agent.displayName.toLowerCase()}@openclaw.example`,
            emailVerified: true,
          })
        }
      },
    },
  })

  const token = await harness.createAdminToken()
  const roleTokens = {
    admin: token,
    operator: await createHarnessRoleToken(harness.directoryDbPath, 'ops@example.com', 'operator', harness.jwtSecret),
    viewer: await createHarnessRoleToken(harness.directoryDbPath, 'viewer@example.com', 'viewer', harness.jwtSecret),
  }
  const adminHeaders = createAdminHeaders(token)

  await requestJson(`${harness.directoryUrl}/admin/workspaces`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'OpenClaw Local',
      slug: workspaceSlug,
      description: 'Central Beam workspace for the first OpenClaw fleet connector.',
      externalHandoffsEnabled: true,
    }),
  })

  for (const agent of Object.values(agents)) {
    await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: agent.beamId,
        bindingType: 'agent',
        owner: harness.adminEmail,
        runtimeType: 'openclaw:fleet',
        policyProfile: 'openclaw-default',
        canInitiateExternal: true,
      }),
    })
  }

  for (const agent of Object.values(agents)) {
    await requestJson(`${harness.directoryUrl}/acl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetBeamId: agent.beamId,
        intentType: 'conversation.message',
        allowedFrom: '*@openclaw.beam.directory',
      }),
    })
  }

  const hosts = {}
  for (const blueprint of hostBlueprints) {
    const enrollment = await createOpenClawEnrollment(harness.directoryUrl, token, {
      label: blueprint.label,
      workspaceSlug: blueprint.workspaceSlug,
      notes: `${blueprint.label} enrollment for fleet validation`,
      expiresInHours: 48,
    })
    const pending = await enrollOpenClawHost(harness.directoryUrl, enrollment.enrollment.token, {
      label: blueprint.label,
      hostname: blueprint.hostname,
      os: blueprint.os,
      connectorVersion: blueprint.connectorVersion,
      beamDirectoryUrl: harness.directoryUrl,
      workspaceSlug: blueprint.workspaceSlug,
      metadata: {
        connector: 'beam-openclaw-host',
        hostKey: blueprint.key,
      },
    })
    const approved = await approveOpenClawHost(harness.directoryUrl, token, pending.host.id)
    const bootstrappedHost = {
      ...blueprint,
      id: approved.host.id,
      credential: approved.credential,
    }
    await syncOpenClawInventory(harness.directoryUrl, approved.credential, bootstrappedHost, [
      buildRoute(bootstrappedHost, bootstrappedHost.agent, bootstrappedHost.routeSource),
    ])
    await heartbeatOpenClawHost(harness.directoryUrl, approved.credential, 1, {
      connectorVersion: bootstrappedHost.connectorVersion,
      hostKey: blueprint.key,
      stage: 'fleet-bootstrap',
    })

    hosts[blueprint.key] = bootstrappedHost
  }

  const clients = {
    alpha: await connectFleetClient(harness.directoryUrl, agents.alpha.beamId),
    beta: await connectFleetClient(harness.directoryUrl, agents.beta.beamId),
    gamma: await connectFleetClient(harness.directoryUrl, agents.gamma.beamId),
  }

  return {
    harness,
    directoryUrl: harness.directoryUrl,
    token,
    roleTokens,
    adminHeaders,
    workspaceSlug,
    agents,
    hosts,
    clients,
    roleHeaders(role = 'admin') {
      return createAdminHeaders(roleTokens[role] ?? token)
    },
    async requestRole(pathname, {
      role = 'admin',
      method = 'GET',
      body,
      allowError = false,
    } = {}) {
      const url = pathname.startsWith('http')
        ? pathname
        : `${harness.directoryUrl}${pathname}`
      const init = {
        method,
        headers: createAdminHeaders(roleTokens[role] ?? token),
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      return allowError
        ? requestJsonAllow(url, init)
        : requestJson(url, init)
    },
    async fetchFleetOverview(role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/overview`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchFleetAnalytics(role = 'viewer') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/analytics`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchFleetReconciliation(role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/reconciliation`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchFleetDigest(params = {}, role = 'admin') {
      const query = new URLSearchParams()
      if (params.format) {
        query.set('format', params.format)
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      if (params.format === 'markdown') {
        const response = await fetch(`${harness.directoryUrl}/admin/openclaw/fleet/digest${suffix}`, {
          headers: this.roleHeaders(role),
        })
        if (!response.ok) {
          throw new Error(`Fleet digest request failed with ${response.status}`)
        }
        return response.text()
      }
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest${suffix}`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchFleetAlerts(role = 'viewer') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/alerts`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchFleetSupportBundle(params = {}, role = 'operator', allowError = false) {
      const query = new URLSearchParams()
      if (params.hostId) {
        query.set('hostId', String(params.hostId))
      }
      if (params.workspaceSlug) {
        query.set('workspaceSlug', params.workspaceSlug)
      }
      if (params.traceNonce) {
        query.set('traceNonce', params.traceNonce)
      }
      if (params.hours) {
        query.set('hours', String(params.hours))
      }

      const url = `${harness.directoryUrl}/admin/openclaw/fleet/support-bundle${query.size > 0 ? `?${query.toString()}` : ''}`
      const response = await fetch(url, {
        headers: this.roleHeaders(role),
      })
      const text = await response.text()
      let payload = null
      if (text.length > 0) {
        payload = JSON.parse(text)
      }
      if (!response.ok && !allowError) {
        throw new Error(`Fleet support bundle request failed with ${response.status}: ${text}`)
      }
      return {
        status: response.status,
        payload,
        filename: response.headers.get('content-disposition') ?? null,
      }
    },
    async listEnrollments(role = 'operator') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/enrollment`, {
        headers: this.roleHeaders(role),
      })
    },
    async createEnrollment(input, role = 'operator', allowError = false) {
      return this.requestRole('/admin/openclaw/hosts/enrollment', {
        role,
        method: 'POST',
        body: input,
        allowError,
      })
    },
    async listRoles(role = 'viewer') {
      return requestJson(`${harness.directoryUrl}/admin/roles`, {
        headers: this.roleHeaders(role),
      })
    },
    async assignRole(email, assignedRole, role = 'admin', allowError = false) {
      return this.requestRole('/admin/roles', {
        role,
        method: 'POST',
        body: {
          email,
          role: assignedRole,
        },
        allowError,
      })
    },
    async revokeRole(email, role = 'admin', allowError = false) {
      return this.requestRole(`/admin/roles/${encodeURIComponent(email)}`, {
        role,
        method: 'DELETE',
        allowError,
      })
    },
    async createFleetAlertTarget(input, role = 'admin', allowError = false) {
      return this.requestRole('/admin/openclaw/fleet/alerts', {
        role,
        method: 'POST',
        body: input,
        allowError,
      })
    },
    async updateFleetAlertTarget(targetId, input, role = 'admin', allowError = false) {
      return this.requestRole(`/admin/openclaw/fleet/alerts/${targetId}`, {
        role,
        method: 'PATCH',
        body: input,
        allowError,
      })
    },
    async testFleetAlertTarget(targetId, role = 'operator', allowError = false) {
      return this.requestRole(`/admin/openclaw/fleet/alerts/${targetId}/test`, {
        role,
        method: 'POST',
        allowError,
      })
    },
    async updateFleetDigestSchedule(input, role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/schedule`, {
        method: 'PATCH',
        headers: this.roleHeaders(role),
        body: JSON.stringify(input),
      })
    },
    async runFleetDigest(input = {}, role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/run`, {
        method: 'POST',
        headers: this.roleHeaders(role),
        body: JSON.stringify(input),
      })
    },
    async deliverFleetDigest(input = {}, role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/deliver`, {
        method: 'POST',
        headers: this.roleHeaders(role),
        body: JSON.stringify(input),
      })
    },
    async runFleetReconciliation(input = {}, role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/reconciliation/run`, {
        method: 'POST',
        headers: this.roleHeaders(role),
        body: JSON.stringify(input),
      })
    },
    async fetchHost(hostId, role = 'admin') {
      const host = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hostId}`, {
        headers: this.roleHeaders(role),
      })
      const identities = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hostId}/identities`, {
        headers: this.roleHeaders(role),
      })
      return {
        ...host,
        identities: identities.identities,
        identitiesTotal: identities.total,
      }
    },
    async fetchWorkspaceIdentities(role = 'admin') {
      return requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
        headers: this.roleHeaders(role),
      })
    },
    async fetchTrace(nonce, role = 'admin') {
      return requestJson(`${harness.directoryUrl}/observability/intents/${encodeURIComponent(nonce)}`, {
        headers: this.roleHeaders(role),
      })
    },
    async createConflict() {
      await syncOpenClawInventory(harness.directoryUrl, hosts.gamma.credential, hosts.gamma, [
        buildRoute(hosts.gamma, hosts.gamma.agent, hosts.gamma.routeSource),
        buildRoute(hosts.gamma, hosts.alpha.agent, 'subagent-run', 'duplicate-alpha'),
      ])
      await heartbeatOpenClawHost(harness.directoryUrl, hosts.gamma.credential, 2, {
        connectorVersion: hosts.gamma.connectorVersion,
        hostKey: 'gamma',
        stage: 'duplicate-route',
      })
    },
    async rotateHost(hostKey, role = 'admin', allowError = false) {
      const response = await this.requestRole(`/admin/openclaw/hosts/${hosts[hostKey].id}/rotate`, {
        role,
        method: 'POST',
        body: { confirmPhrase: 'ROTATE_HOST' },
        allowError,
      })
      if (allowError) {
        return response
      }
      hosts[hostKey].credential = response.credential
      return response
    },
    async recoverHost(hostKey, role = 'admin', allowError = false) {
      const response = await this.requestRole(`/admin/openclaw/hosts/${hosts[hostKey].id}/recover`, {
        role,
        method: 'POST',
        body: { confirmPhrase: 'RECOVER_HOST' },
        allowError,
      })
      if (allowError) {
        return response
      }
      hosts[hostKey].credential = response.credential
      return response
    },
    async revokeHost(hostKey, reason, role = 'admin', allowError = false) {
      return this.requestRole(`/admin/openclaw/hosts/${hosts[hostKey].id}/revoke`, {
        role,
        method: 'POST',
        body: { reason, confirmPhrase: 'REVOKE_HOST' },
        allowError,
      })
    },
    async enableMaintenance(hostKey, input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/maintenance`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({
          confirmPhrase: 'MAINTENANCE_HOST',
          ...input,
        }),
      })
    },
    async drainHost(hostKey, input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/drain`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({
          confirmPhrase: 'DRAIN_HOST',
          ...input,
        }),
      })
    },
    async resumeHost(hostKey) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/resume`, {
        method: 'POST',
        headers: createAdminHeaders(token),
      })
    },
    async updateRollout(hostKey, input) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/rollout`, {
        method: 'PATCH',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async rollbackHost(hostKey, input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/rollback`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({
          confirmPhrase: 'ROLLBACK_HOST',
          ...input,
        }),
      })
    },
    setHostConnectorVersion(hostKey, version) {
      hosts[hostKey].connectorVersion = version
      return hosts[hostKey]
    },
    async syncHost(hostKey, routes = null, details = {}) {
      const host = hosts[hostKey]
      const inventoryRoutes = routes ?? [buildRoute(host, host.agent, host.routeSource)]
      await syncOpenClawInventory(harness.directoryUrl, host.credential, host, inventoryRoutes)
      await heartbeatOpenClawHost(harness.directoryUrl, host.credential, inventoryRoutes.length, {
        connectorVersion: host.connectorVersion,
        hostKey,
        stage: 'manual-sync',
        ...details,
      })
    },
    async heartbeatHost(hostKey, routeCount = 1, details = {}) {
      return heartbeatOpenClawHost(harness.directoryUrl, hosts[hostKey].credential, routeCount, {
        connectorVersion: hosts[hostKey].connectorVersion,
        hostKey,
        stage: 'manual-heartbeat',
        ...details,
      })
    },
    async reconnectHostClient(hostKey) {
      await closeFleetClient(clients[hostKey])
      clients[hostKey] = await connectFleetClient(harness.directoryUrl, agents[hostKey].beamId)
      return clients[hostKey]
    },
    async preferRoute(routeId, note = 'Preferred route owner') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/routes/${routeId}/prefer`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({ note }),
      })
    },
    async disableRoute(routeId, note = 'Disabled conflicting route') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/routes/${routeId}/disable`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({ note, confirmPhrase: 'DISABLE_ROUTE' }),
      })
    },
    async clearRouteOwner(routeId, note = 'Reset route owner resolution') {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/routes/${routeId}/clear-owner`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({ note }),
      })
    },
    async markHostStale(hostKey, minutesAgo = 10, options = {}) {
      const dbApi = await loadDirectoryDbModule()
      const db = dbApi.createDatabase(harness.directoryDbPath)
      try {
        const staleAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
        db.prepare(`
          UPDATE openclaw_hosts
          SET last_heartbeat_at = ?, health_status = 'watch'
          WHERE id = ?
        `).run(staleAt, hosts[hostKey].id)
        if (options.ageRoutes) {
          db.prepare(`
            UPDATE openclaw_host_routes
            SET last_seen_at = ?, updated_at = ?
            WHERE host_id = ? AND reported_state != 'ended'
          `).run(staleAt, staleAt, hosts[hostKey].id)
        }
        return staleAt
      } finally {
        db.close()
      }
    },
    async cleanup() {
      await Promise.all(Object.values(clients).map((client) => closeFleetClient(client)))
      await harness.cleanup()
    },
  }
}
