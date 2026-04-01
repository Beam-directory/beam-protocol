import { appendFile, mkdir } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { optionalFlag, requestJson } from '../production/shared.mjs'
import {
  loadOpenClawAdminSession,
  loadOpenClawIdentityState,
  persistOpenClawIdentityState,
  storeOpenClawAdminSession,
} from './openclaw-secret-store.mjs'
import { ensureLocalOpenClawAcls, ensureLocalOpenClawRelayTargets, ensureLocalOpenClawShield } from './openclaw-local-trust.mjs'

const directoryUrl = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL || 'http://localhost:43100')
const dashboardUrl = optionalFlag('--dashboard-url', process.env.BEAM_DASHBOARD_URL || 'http://localhost:43173')
const adminEmail = optionalFlag('--email', process.env.BEAM_ADMIN_EMAIL || 'ops@beam.local')
const workspaceSlug = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG || 'openclaw-local')
const workspaceName = optionalFlag('--workspace-name', process.env.BEAM_WORKSPACE_NAME || 'OpenClaw Local')
const identitiesPath = optionalFlag('--identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.json'))
const generatedIdentitiesPath = optionalFlag('--generated-identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.generated.json'))
const mergedIdentitiesPath = optionalFlag('--merged-identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.merged.json'))
const sessionCachePath = optionalFlag('--admin-session-cache', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-admin-session.json'))
const logPath = optionalFlag('--log-path', path.join(os.homedir(), '.openclaw/logs/beam-subagent-sync.log'))
const childSessionKey = optionalFlag('--child-session-key')
const requesterSessionKey = optionalFlag('--requester-session-key')
const runId = optionalFlag('--run-id')
const label = optionalFlag('--label')
const targetAgentId = optionalFlag('--agent-id')

function createAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
}

function capitalize(value) {
  return value.length > 0
    ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
    : value
}

function createIdentityPublicKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function writeLog(message) {
  await mkdir(path.dirname(logPath), { recursive: true })
  await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
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

async function createAdminToken() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const challenge = await requestJsonAllow(`${directoryUrl}/admin/auth/magic-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: dashboardUrl,
      },
      body: JSON.stringify({ email: adminEmail }),
    }, [429])

    if (challenge.status === 429) {
      if (attempt === 5) {
        throw new Error(`Admin auth is still rate limited after ${attempt} attempts.`)
      }
      await sleep(attempt * 1500)
      continue
    }

    const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: challenge.payload.token }),
    })

    const session = {
      token: verify.token,
      createdAt: Date.now(),
    }

    await storeOpenClawAdminSession(sessionCachePath, session)
    return session
  }

  throw new Error('Unable to create an admin session token.')
}

async function loadCachedSession() {
  const session = await loadOpenClawAdminSession(sessionCachePath)
  if (!session || typeof session.token !== 'string') {
    return null
  }

  if (typeof session.createdAt !== 'number') {
    return null
  }

  const maxAgeMs = 6 * 60 * 60 * 1000
  if ((Date.now() - session.createdAt) > maxAgeMs) {
    return null
  }

  return session
}

function parseAgentNameFromSessionKey(sessionKey) {
  const match = typeof sessionKey === 'string'
    ? sessionKey.match(/^agent:([^:]+):/u)
    : null
  return match?.[1] ?? 'openclaw'
}

function parseSubagentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') {
    return null
  }

  const nestedMatch = sessionKey.match(/:subagent:([^:]+)$/u)
  if (nestedMatch?.[1]) {
    return nestedMatch[1]
  }

  const firstMatch = sessionKey.match(/subagent:([^:]+)/u)
  return firstMatch?.[1] ?? null
}

function buildGeneratedIdentity(identityKey, agentName) {
  const keys = createIdentityPublicKey()
  return {
    agentName,
    identityKey,
    orgName: 'openclaw',
    beamId: `${slugify(agentName)}@openclaw.beam.directory`,
    ...keys,
    directoryUrl,
  }
}

function buildDescriptor() {
  if (!childSessionKey || !runId) {
    throw new Error('Missing required --child-session-key or --run-id for OpenClaw subagent sync.')
  }

  const controllerAgent = parseAgentNameFromSessionKey(requesterSessionKey)
  const subagentId = parseSubagentIdFromSessionKey(childSessionKey) ?? runId
  const shortId = subagentId.slice(0, 8)
  const normalizedLabel = typeof label === 'string' && label.trim().length > 0 ? label.trim() : null

  return {
    agentName: normalizedLabel
      ? `${controllerAgent}-${slugify(normalizedLabel)}`
      : `${controllerAgent}-subagent-${shortId}`,
    identityKey: `subagent-${controllerAgent}-${shortId}`,
    controllerAgent,
    role: normalizedLabel
      ? `Subagent (${normalizedLabel}) of ${controllerAgent}`
      : `Subagent of ${controllerAgent}`,
    runtimeType: `openclaw-subagent:${controllerAgent}`,
    displayName: normalizedLabel
      ? `${capitalize(controllerAgent)} Subagent (${normalizedLabel})`
      : `${capitalize(controllerAgent)} Subagent ${shortId}`,
    label: normalizedLabel,
    runId,
    childSessionKey,
    targetAgentId: typeof targetAgentId === 'string' && targetAgentId.trim().length > 0
      ? targetAgentId.trim()
      : null,
  }
}

async function ensureWorkspace(adminHeaders) {
  const existing = await requestJsonAllow(`${directoryUrl}/admin/workspaces/${workspaceSlug}`, {
    headers: { Authorization: adminHeaders.Authorization },
  }, [404])

  if (existing.status === 200 && existing.payload?.workspace) {
    return existing.payload.workspace
  }

  const created = await requestJson(`${directoryUrl}/admin/workspaces`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: workspaceName,
      slug: workspaceSlug,
      description: 'Imported OpenClaw roster with Beam identities and workspace control-plane bindings.',
      status: 'active',
      externalHandoffsEnabled: true,
    }),
  })

  return created.workspace
}

async function getPublicEndpointPolicy(adminHeaders) {
  const response = await requestJson(`${directoryUrl}/shield/policies/public-endpoints`, {
    headers: { Authorization: adminHeaders.Authorization },
  })
  return response.policy
}

async function patchPublicEndpointPolicy(adminHeaders, policyPatch) {
  const response = await requestJson(`${directoryUrl}/shield/policies/public-endpoints`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify(policyPatch),
  })
  return response.policy
}

async function ensureDirectoryAgent(identity, displayName, description) {
  const existing = await requestJsonAllow(`${directoryUrl}/agents/${encodeURIComponent(identity.beamId)}`, undefined, [404])
  if (existing.status === 200 && existing.payload) {
    return { agent: existing.payload, apiKey: identity.apiKey ?? null, registeredNow: false }
  }

  const created = await requestJson(`${directoryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      beamId: identity.beamId,
      displayName,
      capabilities: ['conversation.message', 'task.delegate'],
      publicKey: identity.publicKeyBase64,
      description,
      visibility: 'unlisted',
    }),
  })

  return {
    agent: created,
    apiKey: typeof created.apiKey === 'string' ? created.apiKey : null,
    registeredNow: true,
  }
}

async function reissueLocalCredential(adminHeaders, bindingId) {
  return requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities/${bindingId}/reissue-local-credential`, {
    method: 'POST',
    headers: adminHeaders,
  })
}

function buildBindingNotes(descriptor) {
  const segments = [
    `Synced directly from OpenClaw subagent spawn ${descriptor.runId}.`,
    `Controller: ${descriptor.controllerAgent}.`,
    `Child session: ${descriptor.childSessionKey}.`,
  ]

  if (descriptor.label) {
    segments.push(`Label: ${descriptor.label}.`)
  }

  if (descriptor.targetAgentId) {
    segments.push(`Target agent: ${descriptor.targetAgentId}.`)
  }

  return segments.join(' ')
}

async function ensureBinding(adminHeaders, identity, descriptor) {
  const list = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    headers: { Authorization: adminHeaders.Authorization },
  })
  const existing = list.bindings.find((entry) => entry.beamId === identity.beamId)
  const notes = buildBindingNotes(descriptor)

  if (existing) {
    const updated = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities/${existing.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: adminEmail,
        runtimeType: descriptor.runtimeType,
        policyProfile: 'openclaw-default',
        canInitiateExternal: true,
        status: 'active',
        notes,
      }),
    })
    return updated.binding
  }

  const created = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      beamId: identity.beamId,
      bindingType: 'agent',
      owner: adminEmail,
      runtimeType: descriptor.runtimeType,
      policyProfile: 'openclaw-default',
      canInitiateExternal: true,
      status: 'active',
      notes,
    }),
  })

  return created.binding
}

async function listWorkspaceBeamIds(adminHeaders) {
  const list = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    headers: { Authorization: adminHeaders.Authorization },
  })

  return Array.isArray(list.bindings)
    ? list.bindings
      .map((entry) => entry.beamId)
      .filter((value) => typeof value === 'string' && value.length > 0)
    : []
}

async function performSync(session = null, allowRefresh = true) {
  const descriptor = buildDescriptor()
  const identityState = await loadOpenClawIdentityState({
    identitiesPath,
    generatedIdentitiesPath,
    mergedIdentitiesPath,
  })
  const baseIdentities = identityState.baseIdentities
  const generatedIdentities = identityState.generatedIdentities

  const activeSession = session ?? await loadCachedSession() ?? await createAdminToken()
  const adminHeaders = createAdminHeaders(activeSession.token)

  try {
    await ensureWorkspace(adminHeaders)

    const generatedUpdates = { ...generatedIdentities }
    let originalPolicy = null

    try {
      let identity = generatedUpdates[descriptor.identityKey]
        ?? baseIdentities[descriptor.identityKey]
        ?? generatedUpdates[descriptor.agentName]
        ?? baseIdentities[descriptor.agentName]
        ?? null

      if (!identity) {
        identity = buildGeneratedIdentity(descriptor.identityKey, descriptor.agentName)
        generatedUpdates[descriptor.identityKey] = identity
      }

      originalPolicy = await getPublicEndpointPolicy(adminHeaders)
      const trustedIps = [...new Set([...(originalPolicy.trustedIps ?? []), '127.0.0.1', '::1', 'unknown'])]
      await patchPublicEndpointPolicy(adminHeaders, {
        trustedIps,
        registrationPerMinute: Math.max(originalPolicy.registrationPerMinute ?? 10, 20),
      })
      await ensureLocalOpenClawRelayTargets(directoryUrl, adminHeaders)

      const description = descriptor.role
        ? `Imported OpenClaw agent. ${descriptor.role}`
        : 'Imported OpenClaw agent.'
      const registration = await ensureDirectoryAgent(identity, descriptor.displayName, description)
      if (registration.apiKey) {
        generatedUpdates[descriptor.identityKey] = {
          ...identity,
          agentName: descriptor.agentName,
          identityKey: descriptor.identityKey,
          directoryUrl,
          apiKey: registration.apiKey,
        }
      }

      await ensureLocalOpenClawShield(directoryUrl, adminHeaders, registration.agent.beamId ?? registration.agent.beam_id ?? identity.beamId)

      const binding = await ensureBinding(adminHeaders, {
        ...identity,
        beamId: registration.agent.beamId ?? registration.agent.beam_id ?? identity.beamId,
      }, descriptor)

      const activeIdentity = generatedUpdates[descriptor.identityKey]
        ?? baseIdentities[descriptor.identityKey]
        ?? generatedUpdates[descriptor.agentName]
        ?? baseIdentities[descriptor.agentName]
        ?? identity

      if (!activeIdentity.privateKeyBase64 || !activeIdentity.apiKey) {
        const reissued = await reissueLocalCredential(adminHeaders, binding.id)
        generatedUpdates[descriptor.identityKey] = {
          ...activeIdentity,
          agentName: descriptor.agentName,
          identityKey: descriptor.identityKey,
          beamId: reissued.credential.beamId,
          directoryUrl: reissued.credential.directoryUrl ?? directoryUrl,
          publicKeyBase64: reissued.credential.publicKey,
          privateKeyBase64: reissued.credential.privateKey,
          apiKey: reissued.credential.apiKey,
        }
      }

      const workspaceBeamIds = await listWorkspaceBeamIds(adminHeaders)
      await ensureLocalOpenClawAcls(directoryUrl, adminHeaders, workspaceBeamIds)

      await persistOpenClawIdentityState({
        baseIdentities,
        generatedIdentities: generatedUpdates,
        generatedIdentitiesPath,
        mergedIdentitiesPath,
      })

      await writeLog(`Synced ${descriptor.agentName} -> ${binding.beamId ?? identity.beamId} for run ${descriptor.runId}`)
      return
    } finally {
      if (originalPolicy) {
        await patchPublicEndpointPolicy(adminHeaders, originalPolicy)
      }
    }
  } catch (error) {
    const message = formatErrorMessage(error)
    const looksLikeAuthFailure = message.includes(' 401:') || message.includes(' 403:')
    if (allowRefresh && looksLikeAuthFailure) {
      const refreshedSession = await createAdminToken()
      return performSync(refreshedSession, false)
    }

    throw error
  }
}

async function main() {
  try {
    await performSync()
  } catch (error) {
    await writeLog(`Failed to sync spawned subagent: ${formatErrorMessage(error)}`)
    process.exitCode = 1
  }
}

await main()
