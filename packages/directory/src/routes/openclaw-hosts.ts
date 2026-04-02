import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import {
  applyOpenClawHostRouteEvents,
  approveOpenClawHost,
  createOpenClawEnrollmentRequest,
  createOpenClawHost,
  getAgent,
  getOpenClawEnrollmentRequestById,
  getOpenClawEnrollmentRequestByKey,
  getOpenClawHostByEnrollmentRequestId,
  getOpenClawHostById,
  getOpenClawHostByKey,
  getWorkspaceById,
  getWorkspaceBySlug,
  listOpenClawEnrollmentRequests,
  listOpenClawHostHeartbeats,
  listOpenClawHosts,
  listOpenClawResolvedRoutesByBeamId,
  listOpenClawResolvedRoutesForHost,
  listWorkspaceIdentityBindingsByBeamId,
  logAuditEvent,
  recordOpenClawHostHeartbeat,
  recalculateOpenClawRouteStates,
  refreshOpenClawHostHealth,
  revokeOpenClawHost,
  syncOpenClawHostRoutes,
  updateOpenClawEnrollmentRequest,
  updateOpenClawHost,
} from '../db.js'
import { createHostApiKey, getSuppliedApiKey, hostApiKeyMatches, hostKeyFromApiKey } from '../api-key.js'
import type {
  OpenClawHostEnrollmentRequestRow,
  OpenClawHostHealth,
  OpenClawHostRow,
  OpenClawHostRouteRow,
  OpenClawResolvedRouteRow,
  OpenClawRouteReportedState,
  OpenClawRouteSource,
} from '../types.js'

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeOpenClawRouteSource(value: unknown): OpenClawRouteSource | null {
  return value === 'agent-folder' || value === 'workspace-agent' || value === 'gateway-agent' || value === 'subagent-run'
    ? value
    : null
}

function normalizeReportedState(value: unknown): OpenClawRouteReportedState | null {
  return value === 'live' || value === 'idle' || value === 'ended'
    ? value
    : null
}

function normalizeConnectionMode(value: unknown): OpenClawHostRouteRow['connection_mode'] {
  return value === 'websocket' || value === 'http' || value === 'hybrid' || value === 'unavailable'
    ? value
    : null
}

function normalizeHours(value: unknown, fallback = 72): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(24 * 30, parsed)
}

function nowPlusHoursIso(hours: number): string {
  return new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString()
}

function hoursSince(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.round(((Date.now() - parsed) / 3_600_000) * 10) / 10
}

function serializeEnrollment(row: OpenClawHostEnrollmentRequestRow | null) {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    label: row.label,
    workspaceSlug: row.workspace_slug,
    notes: row.notes,
    status: row.status,
    claimedHostId: row.claimed_host_id,
    claimedAt: row.claimed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeRoute(db: Database, row: OpenClawResolvedRouteRow) {
  const workspace = row.workspace_slug ? getWorkspaceBySlug(db, row.workspace_slug) : null
  const bindings = listWorkspaceIdentityBindingsByBeamId(db, row.beam_id)
  const displayName = getAgent(db, row.beam_id)?.display_name ?? null

  return {
    id: row.id,
    beamId: row.beam_id,
    workspaceSlug: row.workspace_slug,
    workspace: workspace ? {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    } : null,
    routeSource: row.route_source,
    routeKey: row.route_key,
    runtimeType: row.runtime_type,
    label: row.label,
    displayName,
    connectionMode: row.connection_mode,
    httpEndpoint: row.http_endpoint,
    sessionKey: row.session_key,
    reportedState: row.reported_state,
    runtimeSessionState: row.runtime_session_state,
    hostId: row.host_id,
    hostLabel: row.host_label,
    hostHealth: row.host_health_status,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : null,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bindings: bindings.map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspace_id,
      bindingType: binding.binding_type,
      status: binding.status,
      owner: binding.owner,
      runtimeType: binding.runtime_type,
    })),
  }
}

function summarizeRoutes(routes: OpenClawResolvedRouteRow[]) {
  return routes.reduce((summary, route) => {
    summary.total += 1
    switch (route.runtime_session_state) {
      case 'live':
        summary.live += 1
        break
      case 'stale':
        summary.stale += 1
        break
      case 'conflict':
        summary.conflict += 1
        break
      case 'ended':
        summary.ended += 1
        break
      default:
        summary.idle += 1
        break
    }
    return summary
  }, {
    total: 0,
    live: 0,
    idle: 0,
    stale: 0,
    conflict: 0,
    ended: 0,
  })
}

function serializeHost(db: Database, host: OpenClawHostRow) {
  const enrollment = host.enrollment_request_id
    ? listOpenClawEnrollmentRequests(db).find((entry) => entry.id === host.enrollment_request_id) ?? null
    : null
  const routes = listOpenClawResolvedRoutesForHost(db, host.id)
  const summary = summarizeRoutes(routes)

  return {
    id: host.id,
    hostKey: host.host_key,
    label: host.label,
    hostname: host.hostname,
    os: host.os,
    connectorVersion: host.connector_version,
    beamDirectoryUrl: host.beam_directory_url,
    workspaceSlug: host.workspace_slug,
    status: host.status,
    healthStatus: host.health_status,
    routeCount: host.route_count,
    approvedAt: host.approved_at,
    approvedBy: host.approved_by,
    revokedAt: host.revoked_at,
    revocationReason: host.revocation_reason,
    lastHeartbeatAt: host.last_heartbeat_at,
    lastHeartbeatAgeHours: hoursSince(host.last_heartbeat_at),
    lastInventoryAt: host.last_inventory_at,
    lastRouteEventAt: host.last_route_event_at,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    enrollment: serializeEnrollment(enrollment),
    summary,
  }
}

function listConflictGroups(db: Database) {
  refreshOpenClawHostHealth(db)
  recalculateOpenClawRouteStates(db)

  const rows = db.prepare(`
    SELECT DISTINCT beam_id
    FROM openclaw_host_routes
    WHERE runtime_session_state = 'conflict'
    ORDER BY beam_id ASC
  `).all() as Array<{ beam_id: string }>

  return rows.map((row) => {
    const routes = listOpenClawResolvedRoutesByBeamId(db, row.beam_id)
      .filter((route) => route.runtime_session_state === 'conflict')
      .map((route) => ({
        hostId: route.host_id,
        hostLabel: route.host_label,
        hostname: route.hostname,
        workspaceSlug: route.workspace_slug,
        routeKey: route.route_key,
        routeSource: route.route_source,
      }))

    return {
      beamId: row.beam_id,
      routeCount: routes.length,
      routes,
    }
  })
}

function requireHostCredential(db: Database, req: Request): OpenClawHostRow | Response {
  refreshOpenClawHostHealth(db)
  const suppliedApiKey = getSuppliedApiKey(req)
  const hostKey = hostKeyFromApiKey(suppliedApiKey)
  if (!hostKey) {
    return new Response(JSON.stringify({ error: 'Host credential required', errorCode: 'HOST_AUTH_REQUIRED' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const host = getOpenClawHostByKey(db, hostKey)
  if (!host || !hostApiKeyMatches(host, suppliedApiKey)) {
    return new Response(JSON.stringify({ error: 'Invalid host credential', errorCode: 'HOST_AUTH_INVALID' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (host.status === 'revoked') {
    return new Response(JSON.stringify({ error: 'Host credential revoked', errorCode: 'HOST_REVOKED' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  return host
}

export function openClawAdminRouter(db: Database) {
  const router = new Hono()

  router.get('/fleet/overview', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const hosts = listOpenClawHosts(db).map((host) => serializeHost(db, host))
    const conflicts = listConflictGroups(db)
    const summary = hosts.reduce((acc, host) => {
      acc.totalHosts += 1
      if (host.status === 'pending') acc.pendingHosts += 1
      if (host.status === 'active') acc.activeHosts += 1
      if (host.status === 'revoked') acc.revokedHosts += 1
      if (host.healthStatus === 'stale') acc.staleHosts += 1
      acc.liveRoutes += host.summary.live
      acc.staleRoutes += host.summary.stale
      acc.conflictRoutes += host.summary.conflict
      acc.endedRoutes += host.summary.ended
      return acc
    }, {
      totalHosts: 0,
      pendingHosts: 0,
      activeHosts: 0,
      revokedHosts: 0,
      staleHosts: 0,
      liveRoutes: 0,
      staleRoutes: 0,
      conflictRoutes: 0,
      endedRoutes: 0,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      summary: {
        ...summary,
        duplicateIdentityConflicts: conflicts.length,
      },
      hosts,
      conflicts,
    })
  })

  router.post('/hosts/enrollment', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const enrollment = createOpenClawEnrollmentRequest(db, {
      label: normalizeOptionalString(body.label),
      workspaceSlug: normalizeOptionalString(body.workspaceSlug),
      notes: normalizeOptionalString(body.notes),
      expiresAt: nowPlusHoursIso(normalizeHours(body.expiresInHours, 72)),
    })

    logAuditEvent(db, {
      action: 'admin.openclaw_host.enrollment.created',
      actor: auth.session.email,
      target: `openclaw-enrollment:${enrollment.id}`,
      details: {
        role: auth.session.role,
        label: enrollment.label,
        workspaceSlug: enrollment.workspace_slug,
        expiresAt: enrollment.expires_at,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      enrollment: {
        ...serializeEnrollment(enrollment),
        token: enrollment.request_key,
      },
    }, 201)
  })

  router.get('/hosts', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const hosts = listOpenClawHosts(db).map((host) => serializeHost(db, host))
    c.header('Cache-Control', 'no-store')
    return c.json({
      hosts,
      total: hosts.length,
    })
  })

  router.get('/hosts/:id/routes', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const routes = listOpenClawResolvedRoutesForHost(db, host.id).map((route) => serializeRoute(db, route))
    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, host),
      routes,
      total: routes.length,
    })
  })

  router.get('/hosts/:id/identities', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const routes = listOpenClawResolvedRoutesForHost(db, host.id)
    const identities = routes.map((route) => {
      const bindings = listWorkspaceIdentityBindingsByBeamId(db, route.beam_id)
      const agent = getAgent(db, route.beam_id)
      return {
        beamId: route.beam_id,
        displayName: agent?.display_name ?? null,
        org: agent?.org ?? null,
        route: serializeRoute(db, route),
        bindings: bindings.map((binding) => {
          const workspace = getWorkspaceById(db, binding.workspace_id)
          return {
            id: binding.id,
            workspaceId: binding.workspace_id,
            workspaceSlug: workspace?.slug ?? null,
            workspaceName: workspace?.name ?? null,
            bindingType: binding.binding_type,
            status: binding.status,
            owner: binding.owner,
            runtimeType: binding.runtime_type,
          }
        }),
      }
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, host),
      identities,
      total: identities.length,
    })
  })

  router.post('/hosts/:id/approve', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const approved = approveOpenClawHost(db, {
      id: hostId,
      approvedBy: auth.session.email,
    })
    if (!approved) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.approved',
      actor: auth.session.email,
      target: `openclaw-host:${approved.host.id}`,
      details: {
        role: auth.session.role,
        hostname: approved.host.hostname,
        label: approved.host.label,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, approved.host),
      credential: approved.credential,
    })
  })

  router.post('/hosts/:id/revoke', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const revoked = revokeOpenClawHost(db, {
      id: hostId,
      reason: normalizeOptionalString(body.reason),
    })
    if (!revoked) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.revoked',
      actor: auth.session.email,
      target: `openclaw-host:${revoked.id}`,
      details: {
        role: auth.session.role,
        reason: revoked.revocation_reason,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, revoked),
    })
  })

  router.get('/hosts/:id', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, host),
      routes: listOpenClawResolvedRoutesForHost(db, host.id).map((route) => serializeRoute(db, route)),
      heartbeats: listOpenClawHostHeartbeats(db, host.id, 20).map((row) => ({
        id: row.id,
        routeCount: row.route_count,
        connectorVersion: row.connector_version,
        healthStatus: row.health_status,
        details: row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : null,
        heartbeatAt: row.heartbeat_at,
      })),
    })
  })

  return router
}

export function openClawPublicRouter(db: Database) {
  const router = new Hono()

  router.post('/enroll', async (c) => {
    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const enrollmentToken = normalizeOptionalString(body.token)
    if (!enrollmentToken) {
      return c.json({ error: 'token is required', errorCode: 'INVALID_ENROLLMENT_TOKEN' }, 400)
    }

    const request = getOpenClawEnrollmentRequestByKey(db, enrollmentToken)
    if (!request) {
      return c.json({ error: 'Enrollment request not found', errorCode: 'NOT_FOUND' }, 404)
    }

    if (request.status === 'revoked' || request.status === 'expired') {
      return c.json({ error: 'Enrollment request is not active', errorCode: 'ENROLLMENT_INACTIVE' }, 403)
    }

    if (request.expires_at && Date.parse(request.expires_at) < Date.now()) {
      updateOpenClawEnrollmentRequest(db, {
        id: request.id,
        status: 'expired',
      })
      return c.json({ error: 'Enrollment request expired', errorCode: 'ENROLLMENT_EXPIRED' }, 410)
    }

    const hostname = normalizeOptionalString(body.hostname) ?? 'unknown-host'
    const os = normalizeOptionalString(body.os) ?? 'unknown-os'
    const connectorVersion = normalizeOptionalString(body.connectorVersion) ?? '0.0.0'
    const beamDirectoryUrl = normalizeOptionalString(body.beamDirectoryUrl) ?? 'unknown'
    const workspaceSlug = normalizeOptionalString(body.workspaceSlug) ?? request.workspace_slug
    const label = normalizeOptionalString(body.label) ?? request.label
    const metadataJson = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? JSON.stringify(body.metadata)
      : null

    let host = getOpenClawHostByEnrollmentRequestId(db, request.id)
    if (!host) {
      host = createOpenClawHost(db, {
        enrollmentRequestId: request.id,
        label,
        hostname,
        os,
        connectorVersion,
        beamDirectoryUrl,
        workspaceSlug,
        metadataJson,
      })
    } else {
      host = updateOpenClawHost(db, {
        id: host.id,
        label,
        hostname,
        os,
        connectorVersion,
        beamDirectoryUrl,
        workspaceSlug,
        metadataJson,
      }) as OpenClawHostRow
    }

    updateOpenClawEnrollmentRequest(db, {
      id: request.id,
      status: host.status === 'active' ? 'approved' : 'pending',
      claimedHostId: host.id,
      claimedAt: host.status === 'active'
        ? (request.claimed_at ?? host.created_at)
        : new Date().toISOString(),
      approvedAt: host.approved_at,
      approvedBy: host.approved_by,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      approved: host.status === 'active',
      host: serializeHost(db, host),
      enrollment: serializeEnrollment(getOpenClawEnrollmentRequestById(db, request.id)),
      credential: host.status === 'active' ? createHostApiKey(host.host_key) : null,
    }, host.status === 'active' ? 200 : 202)
  })

  router.post('/heartbeat', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const routeCount = normalizePositiveInteger(body.routeCount) ?? host.route_count
    const connectorVersion = normalizeOptionalString(body.connectorVersion) ?? host.connector_version
    const detailsJson = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
      ? JSON.stringify(body.details)
      : null

    const heartbeat = recordOpenClawHostHeartbeat(db, {
      hostId: host.id,
      routeCount,
      connectorVersion,
      detailsJson,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, getOpenClawHostById(db, host.id) as OpenClawHostRow),
      heartbeat: {
        id: heartbeat.id,
        healthStatus: heartbeat.health_status,
        heartbeatAt: heartbeat.heartbeat_at,
      },
    })
  })

  router.post('/inventory', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const routesInput = Array.isArray(body.routes) ? body.routes : []
    const routes = routesInput.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }

      const route = entry as Record<string, unknown>
      const beamId = normalizeOptionalString(route.beamId)
      const routeKey = normalizeOptionalString(route.routeKey)
      const routeSource = normalizeOpenClawRouteSource(route.routeSource)
      if (!beamId || !routeKey || !routeSource) {
        return []
      }

      return [{
        beamId,
        workspaceSlug: normalizeOptionalString(route.workspaceSlug) ?? host.workspace_slug,
        routeSource,
        routeKey,
        runtimeType: normalizeOptionalString(route.runtimeType),
        label: normalizeOptionalString(route.label),
        connectionMode: normalizeConnectionMode(route.connectionMode),
        httpEndpoint: normalizeOptionalString(route.httpEndpoint),
        sessionKey: normalizeOptionalString(route.sessionKey),
        reportedState: normalizeReportedState(route.reportedState) ?? 'idle',
        metadataJson: route.metadata && typeof route.metadata === 'object' && !Array.isArray(route.metadata)
          ? JSON.stringify(route.metadata)
          : null,
        lastSeenAt: normalizeOptionalString(route.lastSeenAt),
        endedAt: normalizeOptionalString(route.endedAt),
      }]
    })

    const updatedHost = updateOpenClawHost(db, {
      id: host.id,
      connectorVersion: normalizeOptionalString(body.connectorVersion) ?? host.connector_version,
      beamDirectoryUrl: normalizeOptionalString(body.beamDirectoryUrl) ?? host.beam_directory_url,
      workspaceSlug: normalizeOptionalString(body.workspaceSlug) ?? host.workspace_slug,
      label: normalizeOptionalString(body.label) ?? host.label,
      hostname: normalizeOptionalString(body.hostname) ?? host.hostname,
      os: normalizeOptionalString(body.os) ?? host.os,
    }) as OpenClawHostRow
    const syncedRoutes = syncOpenClawHostRoutes(db, {
      hostId: host.id,
      routes,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, updatedHost),
      routes: syncedRoutes.map((route) => {
        const resolved = listOpenClawResolvedRoutesByBeamId(db, route.beam_id).find((entry) => entry.id === route.id)
        return resolved ? serializeRoute(db, resolved) : null
      }).filter(Boolean),
      total: syncedRoutes.length,
    })
  })

  router.post('/route-events', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const eventsInput = Array.isArray(body.events) ? body.events : []
    const events = eventsInput.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }

      const event = entry as Record<string, unknown>
      const beamId = normalizeOptionalString(event.beamId)
      const routeKey = normalizeOptionalString(event.routeKey)
      const routeSource = normalizeOpenClawRouteSource(event.routeSource)
      if (!beamId || !routeKey || !routeSource) {
        return []
      }

      return [{
        beamId,
        routeKey,
        routeSource,
        reportedState: normalizeReportedState(event.reportedState) ?? 'idle',
        runtimeType: normalizeOptionalString(event.runtimeType),
        label: normalizeOptionalString(event.label),
        workspaceSlug: normalizeOptionalString(event.workspaceSlug),
        sessionKey: normalizeOptionalString(event.sessionKey),
        connectionMode: normalizeConnectionMode(event.connectionMode),
        httpEndpoint: normalizeOptionalString(event.httpEndpoint),
        metadataJson: event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
          ? JSON.stringify(event.metadata)
          : null,
      }]
    })

    const updatedRoutes = applyOpenClawHostRouteEvents(db, {
      hostId: host.id,
      events,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, getOpenClawHostById(db, host.id) as OpenClawHostRow),
      routes: updatedRoutes.map((route) => {
        const resolved = listOpenClawResolvedRoutesByBeamId(db, route.beam_id).find((entry) => entry.id === route.id)
        return resolved ? serializeRoute(db, resolved) : null
      }).filter(Boolean),
      total: updatedRoutes.length,
    })
  })

  return router
}
