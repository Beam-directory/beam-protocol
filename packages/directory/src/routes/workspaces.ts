import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import {
  createWorkspace,
  createWorkspaceIdentityBinding,
  getAgent,
  getOrg,
  getWorkspaceBySlug,
  getWorkspaceIdentityBindingByBeamId,
  getWorkspaceIdentityBindingById,
  getWorkspacePolicy,
  getWorkspaceSummary,
  listAgentKeys,
  listWorkspaceIdentityBindings,
  listWorkspaces,
  logAuditEvent,
  updateWorkspaceIdentityBinding,
} from '../db.js'
import type {
  WorkspaceIdentityBindingRow,
  WorkspaceIdentityBindingStatus,
  WorkspaceIdentityBindingType,
  WorkspaceRow,
  WorkspaceThreadScope,
} from '../types.js'
import { serializeAgentKeyState } from '../utils/serialize.js'

const WORKSPACE_STATUS_SET = new Set<WorkspaceRow['status']>(['active', 'paused', 'archived'])
const WORKSPACE_THREAD_SCOPE_SET = new Set<WorkspaceThreadScope>(['internal', 'handoff'])
const WORKSPACE_BINDING_TYPE_SET = new Set<WorkspaceIdentityBindingType>(['agent', 'service', 'partner'])
const WORKSPACE_BINDING_STATUS_SET = new Set<WorkspaceIdentityBindingStatus>(['active', 'paused'])
const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
}

function normalizeWorkspaceStatus(value: unknown): WorkspaceRow['status'] | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceRow['status']
  return WORKSPACE_STATUS_SET.has(normalized) ? normalized : null
}

function normalizeWorkspaceThreadScope(value: unknown): WorkspaceThreadScope | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceThreadScope
  return WORKSPACE_THREAD_SCOPE_SET.has(normalized) ? normalized : null
}

function normalizeBindingType(value: unknown): WorkspaceIdentityBindingType | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceIdentityBindingType
  return WORKSPACE_BINDING_TYPE_SET.has(normalized) ? normalized : null
}

function normalizeBindingStatus(value: unknown): WorkspaceIdentityBindingStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceIdentityBindingStatus
  return WORKSPACE_BINDING_STATUS_SET.has(normalized) ? normalized : null
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  return null
}

function normalizeWorkspaceSlug(value: unknown, fallback: string): string | null {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : slugify(fallback)
  if (!candidate || !WORKSPACE_SLUG_RE.test(candidate)) {
    return null
  }

  return candidate
}

function serializeWorkspace(db: Database, row: WorkspaceRow): Record<string, unknown> {
  const summary = getWorkspaceSummary(db, row.id)
  const policy = getWorkspacePolicy(db, row.id)

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    orgName: row.org_name,
    description: row.description,
    status: row.status,
    defaultThreadScope: row.default_thread_scope,
    externalHandoffsEnabled: row.external_handoffs_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: {
      identities: summary.identityCount,
      externalInitiators: summary.externalInitiatorCount,
      members: summary.memberCount,
      partnerChannels: summary.partnerChannelCount,
    },
    policyConfigured: policy !== null,
  }
}

function serializeWorkspaceIdentityBinding(db: Database, row: WorkspaceIdentityBindingRow): Record<string, unknown> {
  const agent = getAgent(db, row.beam_id)
  const keyState = agent ? serializeAgentKeyState(listAgentKeys(db, row.beam_id)) : null

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    beamId: row.beam_id,
    bindingType: row.binding_type,
    owner: row.owner,
    runtimeType: row.runtime_type,
    policyProfile: row.policy_profile,
    defaultThreadScope: row.default_thread_scope,
    canInitiateExternal: row.can_initiate_external === 1,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    identity: agent ? {
      existsLocally: true,
      beamId: agent.beam_id,
      displayName: agent.display_name,
      org: agent.org,
      personal: agent.personal === 1,
      verificationTier: agent.verification_tier,
      trustScore: agent.trust_score,
      lastSeen: agent.last_seen,
      capabilities: JSON.parse(agent.capabilities) as string[],
      keyState,
    } : {
      existsLocally: false,
      beamId: row.beam_id,
      displayName: null,
      org: null,
      personal: false,
      verificationTier: null,
      trustScore: null,
      lastSeen: null,
      capabilities: [],
      keyState,
    },
  }
}

function isUniqueConstraintError(err: unknown, target: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${target}`)
}

export function workspacesRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const rows = listWorkspaces(db)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspaces: rows.map((row) => serializeWorkspace(db, row)),
      total: rows.length,
    })
  })

  router.post('/', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const name = normalizeOptionalString(raw.name)
    if (!name) {
      return c.json({ error: 'name is required', errorCode: 'INVALID_WORKSPACE_NAME' }, 400)
    }

    const slug = normalizeWorkspaceSlug(raw.slug, name)
    if (!slug) {
      return c.json({ error: 'slug must contain lowercase letters, numbers, and dashes only', errorCode: 'INVALID_WORKSPACE_SLUG' }, 400)
    }

    const orgName = normalizeOptionalString(raw.orgName)
    if (orgName && !getOrg(db, orgName)) {
      return c.json({ error: 'orgName was not found', errorCode: 'ORG_NOT_FOUND' }, 404)
    }

    const description = normalizeOptionalString(raw.description)
    const status = 'status' in raw ? normalizeWorkspaceStatus(raw.status) : 'active'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid workspace status', errorCode: 'INVALID_WORKSPACE_STATUS' }, 400)
    }

    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : 'internal'
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const externalHandoffsEnabled = 'externalHandoffsEnabled' in raw
      ? normalizeBoolean(raw.externalHandoffsEnabled)
      : false
    if ('externalHandoffsEnabled' in raw && externalHandoffsEnabled === null) {
      return c.json({ error: 'externalHandoffsEnabled must be boolean', errorCode: 'INVALID_EXTERNAL_HANDOFFS_ENABLED' }, 400)
    }

    try {
      const workspace = createWorkspace(db, {
        slug,
        name,
        orgName,
        description,
        status: status ?? 'active',
        defaultThreadScope: defaultThreadScope ?? 'internal',
        externalHandoffsEnabled: externalHandoffsEnabled ?? false,
      })

      logAuditEvent(db, {
        action: 'admin.workspace.created',
        actor: auth.session.email,
        target: workspace.slug,
        details: {
          role: auth.session.role,
          orgName: workspace.org_name,
          defaultThreadScope: workspace.default_thread_scope,
          externalHandoffsEnabled: workspace.external_handoffs_enabled === 1,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({ workspace: serializeWorkspace(db, workspace) }, 201)
    } catch (err) {
      if (isUniqueConstraintError(err, 'workspaces.slug')) {
        return c.json({ error: 'Workspace slug already exists', errorCode: 'WORKSPACE_SLUG_TAKEN' }, 409)
      }

      console.error('Workspace create error:', err)
      return c.json({ error: 'Failed to create workspace', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/:slug', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({ workspace: serializeWorkspace(db, workspace) })
  })

  router.get('/:slug/identities', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const rows = listWorkspaceIdentityBindings(db, workspace.id)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      bindings: rows.map((row) => serializeWorkspaceIdentityBinding(db, row)),
      total: rows.length,
    })
  })

  router.post('/:slug/identities', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const beamId = normalizeOptionalString(raw.beamId)
    if (!beamId) {
      return c.json({ error: 'beamId is required', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const bindingType = normalizeBindingType(raw.bindingType)
    if (!bindingType) {
      return c.json({ error: 'Invalid bindingType', errorCode: 'INVALID_BINDING_TYPE' }, 400)
    }

    if ((bindingType === 'agent' || bindingType === 'service') && !getAgent(db, beamId)) {
      return c.json({ error: 'Local Beam identity not found', errorCode: 'AGENT_NOT_FOUND' }, 404)
    }

    const owner = normalizeOptionalString(raw.owner)
    const runtimeType = normalizeOptionalString(raw.runtimeType)
    const policyProfile = normalizeOptionalString(raw.policyProfile)
    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : 'internal'
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const canInitiateExternal = 'canInitiateExternal' in raw
      ? normalizeBoolean(raw.canInitiateExternal)
      : false
    if ('canInitiateExternal' in raw && canInitiateExternal === null) {
      return c.json({ error: 'canInitiateExternal must be boolean', errorCode: 'INVALID_CAN_INITIATE_EXTERNAL' }, 400)
    }

    const status = 'status' in raw ? normalizeBindingStatus(raw.status) : 'active'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid binding status', errorCode: 'INVALID_BINDING_STATUS' }, 400)
    }

    const notes = normalizeOptionalString(raw.notes)

    try {
      const existing = getWorkspaceIdentityBindingByBeamId(db, workspace.id, beamId)
      if (existing) {
        return c.json({ error: 'Workspace identity already exists', errorCode: 'WORKSPACE_IDENTITY_EXISTS' }, 409)
      }

      const binding = createWorkspaceIdentityBinding(db, {
        workspaceId: workspace.id,
        beamId,
        bindingType,
        owner,
        runtimeType,
        policyProfile,
        defaultThreadScope: defaultThreadScope ?? 'internal',
        canInitiateExternal: canInitiateExternal ?? false,
        status: status ?? 'active',
        notes,
      })

      logAuditEvent(db, {
        action: 'admin.workspace_identity.created',
        actor: auth.session.email,
        target: `${workspace.slug}:${beamId}`,
        details: {
          role: auth.session.role,
          bindingType,
          owner,
          runtimeType,
          canInitiateExternal: binding.can_initiate_external === 1,
          status: binding.status,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({ binding: serializeWorkspaceIdentityBinding(db, binding) }, 201)
    } catch (err) {
      if (isUniqueConstraintError(err, 'workspace_identity_bindings.workspace_id, workspace_identity_bindings.beam_id')) {
        return c.json({ error: 'Workspace identity already exists', errorCode: 'WORKSPACE_IDENTITY_EXISTS' }, 409)
      }

      console.error('Workspace identity create error:', err)
      return c.json({ error: 'Failed to create workspace identity', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.patch('/:slug/identities/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const bindingId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(bindingId) || bindingId <= 0) {
      return c.json({ error: 'Invalid identity binding id', errorCode: 'INVALID_BINDING_ID' }, 400)
    }

    const existing = getWorkspaceIdentityBindingById(db, bindingId)
    if (!existing || existing.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const owner = 'owner' in raw ? normalizeOptionalString(raw.owner) : existing.owner
    const runtimeType = 'runtimeType' in raw ? normalizeOptionalString(raw.runtimeType) : existing.runtime_type
    const policyProfile = 'policyProfile' in raw ? normalizeOptionalString(raw.policyProfile) : existing.policy_profile
    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : existing.default_thread_scope
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const canInitiateExternal = 'canInitiateExternal' in raw
      ? normalizeBoolean(raw.canInitiateExternal)
      : existing.can_initiate_external === 1
    if ('canInitiateExternal' in raw && canInitiateExternal === null) {
      return c.json({ error: 'canInitiateExternal must be boolean', errorCode: 'INVALID_CAN_INITIATE_EXTERNAL' }, 400)
    }

    const status = 'status' in raw ? normalizeBindingStatus(raw.status) : existing.status
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid binding status', errorCode: 'INVALID_BINDING_STATUS' }, 400)
    }

    const notes = 'notes' in raw ? normalizeOptionalString(raw.notes) : existing.notes

    const updated = updateWorkspaceIdentityBinding(db, {
      id: existing.id,
      owner,
      runtimeType,
      policyProfile,
      defaultThreadScope: defaultThreadScope ?? existing.default_thread_scope,
      canInitiateExternal: canInitiateExternal ?? (existing.can_initiate_external === 1),
      status: status ?? existing.status,
      notes,
    })

    if (!updated) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.workspace_identity.updated',
      actor: auth.session.email,
      target: `${workspace.slug}:${existing.beam_id}`,
      details: {
        role: auth.session.role,
        owner,
        runtimeType,
        policyProfile,
        defaultThreadScope: updated.default_thread_scope,
        canInitiateExternal: updated.can_initiate_external === 1,
        status: updated.status,
        notesChanged: 'notes' in raw,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({ binding: serializeWorkspaceIdentityBinding(db, updated) })
  })

  return router
}
