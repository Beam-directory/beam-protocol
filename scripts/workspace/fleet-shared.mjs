import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  createAdminHeaders,
  loadDirectoryDbModule,
  requestJson,
  startProductionHarness,
} from '../production/shared.mjs'

const connectorVersion = '1.3.0-test'

function createFixtureAgent(beamId, displayName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    beamId,
    displayName,
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
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

export async function heartbeatOpenClawHost(directoryUrl, credential, routeCount, details = {}) {
  return requestJson(`${directoryUrl}/openclaw/hosts/heartbeat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      routeCount,
      connectorVersion,
      details,
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
      connectorVersion,
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
    },
    {
      key: 'beta',
      label: 'OpenClaw Host Beta',
      hostname: 'beta.local',
      os: 'Ubuntu 24.04',
      workspaceSlug,
      routeSource: 'workspace-agent',
      agent: agents.beta,
    },
    {
      key: 'gamma',
      label: 'OpenClaw Host Gamma',
      hostname: 'gamma.local',
      os: 'Debian 12',
      workspaceSlug,
      routeSource: 'subagent-run',
      agent: agents.gamma,
    },
  ]

  const harness = await startProductionHarness({
    withMessageBus: false,
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
      connectorVersion,
      beamDirectoryUrl: harness.directoryUrl,
      workspaceSlug: blueprint.workspaceSlug,
      metadata: {
        connector: 'beam-openclaw-host',
        hostKey: blueprint.key,
      },
    })
    const approved = await approveOpenClawHost(harness.directoryUrl, token, pending.host.id)
    await syncOpenClawInventory(harness.directoryUrl, approved.credential, blueprint, [
      buildRoute(blueprint, blueprint.agent, blueprint.routeSource),
    ])
    await heartbeatOpenClawHost(harness.directoryUrl, approved.credential, 1, {
      hostKey: blueprint.key,
      stage: 'fleet-bootstrap',
    })

    hosts[blueprint.key] = {
      ...blueprint,
      id: approved.host.id,
      credential: approved.credential,
    }
  }

  const clients = {
    alpha: await connectFleetClient(harness.directoryUrl, agents.alpha.beamId),
    beta: await connectFleetClient(harness.directoryUrl, agents.beta.beamId),
    gamma: await connectFleetClient(harness.directoryUrl, agents.gamma.beamId),
  }

  return {
    harness,
    token,
    adminHeaders,
    workspaceSlug,
    agents,
    hosts,
    clients,
    async fetchFleetOverview() {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/overview`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
    async fetchFleetReconciliation() {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/reconciliation`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
    async fetchFleetDigest(params = {}) {
      const query = new URLSearchParams()
      if (params.format) {
        query.set('format', params.format)
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      if (params.format === 'markdown') {
        const response = await fetch(`${harness.directoryUrl}/admin/openclaw/fleet/digest${suffix}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          throw new Error(`Fleet digest request failed with ${response.status}`)
        }
        return response.text()
      }
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
    async updateFleetDigestSchedule(input) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/schedule`, {
        method: 'PATCH',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async runFleetDigest(input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/run`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async deliverFleetDigest(input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/digest/deliver`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async runFleetReconciliation(input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/fleet/reconciliation/run`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async fetchHost(hostId) {
      const host = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hostId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const identities = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hostId}/identities`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return {
        ...host,
        identities: identities.identities,
        identitiesTotal: identities.total,
      }
    },
    async fetchWorkspaceIdentities() {
      return requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
    async fetchTrace(nonce) {
      return requestJson(`${harness.directoryUrl}/observability/intents/${encodeURIComponent(nonce)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
    async createConflict() {
      await syncOpenClawInventory(harness.directoryUrl, hosts.gamma.credential, hosts.gamma, [
        buildRoute(hosts.gamma, hosts.gamma.agent, hosts.gamma.routeSource),
        buildRoute(hosts.gamma, hosts.alpha.agent, 'subagent-run', 'duplicate-alpha'),
      ])
      await heartbeatOpenClawHost(harness.directoryUrl, hosts.gamma.credential, 2, {
        hostKey: 'gamma',
        stage: 'duplicate-route',
      })
    },
    async rotateHost(hostKey) {
      const response = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/rotate`, {
        method: 'POST',
        headers: createAdminHeaders(token),
      })
      hosts[hostKey].credential = response.credential
      return response
    },
    async recoverHost(hostKey) {
      const response = await requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/recover`, {
        method: 'POST',
        headers: createAdminHeaders(token),
      })
      hosts[hostKey].credential = response.credential
      return response
    },
    async revokeHost(hostKey, reason) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/revoke`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({ reason }),
      })
    },
    async enableMaintenance(hostKey, input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/maintenance`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
      })
    },
    async drainHost(hostKey, input = {}) {
      return requestJson(`${harness.directoryUrl}/admin/openclaw/hosts/${hosts[hostKey].id}/drain`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify(input),
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
    async syncHost(hostKey, routes = null, details = {}) {
      const host = hosts[hostKey]
      const inventoryRoutes = routes ?? [buildRoute(host, host.agent, host.routeSource)]
      await syncOpenClawInventory(harness.directoryUrl, host.credential, host, inventoryRoutes)
      await heartbeatOpenClawHost(harness.directoryUrl, host.credential, inventoryRoutes.length, {
        hostKey,
        stage: 'manual-sync',
        ...details,
      })
    },
    async heartbeatHost(hostKey, routeCount = 1, details = {}) {
      return heartbeatOpenClawHost(harness.directoryUrl, hosts[hostKey].credential, routeCount, {
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
        body: JSON.stringify({ note }),
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
