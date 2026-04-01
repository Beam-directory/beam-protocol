import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { optionalFlag, requestJson } from '../production/shared.mjs'

const directoryUrl = optionalFlag('--directory-url', 'http://localhost:43100')
const dashboardUrl = optionalFlag('--dashboard-url', 'http://localhost:43173')
const adminEmail = optionalFlag('--email', 'ops@beam.local')
const workspaceSlug = optionalFlag('--workspace', 'openclaw-local')
const workspaceName = optionalFlag('--workspace-name', 'OpenClaw Local')
const agentsDir = optionalFlag('--agents-dir', path.join(os.homedir(), '.openclaw/agents'))
const workspaceAgentsDir = optionalFlag('--workspace-agents-dir', path.join(os.homedir(), '.openclaw/workspace/agents'))
const identitiesPath = optionalFlag('--identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.json'))
const generatedIdentitiesPath = optionalFlag('--generated-identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.generated.json'))
const mergedIdentitiesPath = optionalFlag('--merged-identities', path.join(os.homedir(), '.openclaw/workspace/secrets/beam-identities.merged.json'))
const subagentRunsPath = optionalFlag('--subagent-runs', path.join(os.homedir(), '.openclaw/subagents/runs.json'))
const subagentDays = Number.parseInt(optionalFlag('--subagent-days', '30'), 10)
const subagentLimit = Number.parseInt(optionalFlag('--subagent-limit', '25'), 10)
const watchMode = process.argv.includes('--watch')
const watchDebounceMs = Number.parseInt(optionalFlag('--watch-debounce-ms', '750'), 10)
const registerMissing = process.argv.includes('--register-missing')
const includeSubagents = !process.argv.includes('--no-subagents')

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

async function readJsonFile(filePath, fallback) {
  try {
    const text = await readFile(filePath, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function directoryFingerprint(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return ''
  }

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${entry.name}:${fileMtimeMs(path.join(rootDir, entry.name))}`)
    .sort((left, right) => left.localeCompare(right))
    .join('|')
}

function sourceFingerprint() {
  return JSON.stringify({
    agentsDir: directoryFingerprint(agentsDir),
    workspaceAgentsDir: directoryFingerprint(workspaceAgentsDir),
    identitiesPath: fileMtimeMs(identitiesPath),
    generatedIdentitiesPath: fileMtimeMs(generatedIdentitiesPath),
    subagentRunsPath: fileMtimeMs(subagentRunsPath),
  })
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

    return {
      token: verify.token,
      magicUrl: challenge.payload.url,
    }
  }

  throw new Error('Unable to create an admin session token.')
}

function listAgentDirectories(rootDir, source) {
  if (!fs.existsSync(rootDir)) {
    return []
  }

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      agentName: entry.name,
      identityKey: entry.name,
      source,
      rootDir,
      runtimeType: source === 'workspace-agent'
        ? `openclaw-workspace:${entry.name}`
        : `openclaw:${entry.name}`,
      role: null,
    }))
    .sort((left, right) => left.agentName.localeCompare(right.agentName))
}

async function readAgentMarkdown(rootDir, agentName) {
  const candidates = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md']
  for (const candidate of candidates) {
    try {
      return await readFile(path.join(rootDir, agentName, candidate), 'utf8')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  return ''
}

function extractDisplayName(agentName, markdown) {
  const headingMatch = markdown.match(/^#\s+IDENTITY(?:\.md)?\s*[-—]\s*(.+)$/im)
  if (headingMatch?.[1]) {
    return headingMatch[1].trim()
  }

  const nameBullet = markdown.match(/^- \*\*Name:\*\*\s*(.+)$/im)
  if (nameBullet?.[1]) {
    return nameBullet[1].trim()
  }

  const genericHeading = markdown.match(/^#\s+(.+)$/im)
  if (genericHeading?.[1]) {
    return genericHeading[1].trim()
  }

  return agentName
}

function extractRole(markdown) {
  const roleBullet = markdown.match(/^- \*\*Role:\*\*\s*(.+)$/im)
  const creatureBullet = markdown.match(/^- \*\*Creature:\*\*\s*(.+)$/im)
  return roleBullet?.[1]?.trim() ?? creatureBullet?.[1]?.trim() ?? null
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

function normalizeSubagentDescriptors(runsPayload) {
  const runs = Object.values(runsPayload?.runs ?? {})
  const cutoff = Number.isFinite(subagentDays) && subagentDays > 0
    ? Date.now() - (subagentDays * 24 * 60 * 60 * 1000)
    : 0
  const limit = Number.isFinite(subagentLimit) && subagentLimit > 0 ? subagentLimit : 25

  return runs
    .map((run) => {
      const childSessionKey = typeof run.childSessionKey === 'string' ? run.childSessionKey : null
      const subagentId = parseSubagentIdFromSessionKey(childSessionKey)
      if (!subagentId) {
        return null
      }

      const endedAt = typeof run.endedAt === 'number' ? run.endedAt : null
      const createdAt = typeof run.createdAt === 'number' ? run.createdAt : null
      const referenceTime = endedAt ?? createdAt ?? 0
      if (referenceTime < cutoff) {
        return null
      }

      const controllerAgent = parseAgentNameFromSessionKey(run.controllerSessionKey)
      const shortId = subagentId.slice(0, 8)
      const label = typeof run.label === 'string' && run.label.trim().length > 0 ? run.label.trim() : null
      const taskPreview = typeof run.task === 'string'
        ? run.task.replace(/\s+/gu, ' ').trim().slice(0, 160)
        : null

      return {
        agentName: label ? `${controllerAgent}-${slugify(label)}` : `${controllerAgent}-subagent-${shortId}`,
        identityKey: `subagent-${controllerAgent}-${shortId}`,
        source: 'subagent-run',
        rootDir: null,
        runtimeType: `openclaw-subagent:${controllerAgent}`,
        role: label ? `Subagent (${label}) of ${controllerAgent}` : `Subagent of ${controllerAgent}`,
        controllerAgent,
        label,
        runId: typeof run.runId === 'string' ? run.runId : shortId,
        taskPreview,
        displayName: label
          ? `${capitalize(controllerAgent)} Subagent (${label})`
          : `${capitalize(controllerAgent)} Subagent ${shortId}`,
        createdAt: referenceTime,
      }
    })
    .filter(Boolean)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, limit)
}

async function listOpenClawDescriptors() {
  const persistentAgents = listAgentDirectories(agentsDir, 'agent-folder')
  const workspaceAgents = listAgentDirectories(workspaceAgentsDir, 'workspace-agent')
  const subagents = includeSubagents
    ? normalizeSubagentDescriptors(await readJsonFile(subagentRunsPath, { version: 0, runs: {} }))
    : []

  const descriptors = new Map()
  for (const descriptor of [...persistentAgents, ...workspaceAgents, ...subagents]) {
    if (!descriptors.has(descriptor.identityKey)) {
      descriptors.set(descriptor.identityKey, descriptor)
    }
  }

  return {
    descriptors: [...descriptors.values()],
    counts: {
      persistentAgents: persistentAgents.length,
      workspaceAgents: workspaceAgents.length,
      subagents: subagents.length,
    },
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

function buildBindingNotes(descriptor) {
  if (descriptor.source === 'subagent-run') {
    const segments = [
      `Imported from OpenClaw subagent run ${descriptor.runId}.`,
      `Controller: ${descriptor.controllerAgent}.`,
    ]
    if (descriptor.label) {
      segments.push(`Label: ${descriptor.label}.`)
    }
    if (descriptor.taskPreview) {
      segments.push(`Task: ${descriptor.taskPreview}`)
    }
    return segments.join(' ')
  }

  if (descriptor.source === 'workspace-agent') {
    return descriptor.role
      ? `Imported from OpenClaw workspace agent folder ${descriptor.agentName}. Role: ${descriptor.role}.`
      : `Imported from OpenClaw workspace agent folder ${descriptor.agentName}.`
  }

  return descriptor.role
    ? `Imported from OpenClaw agent folder ${descriptor.agentName}. Role: ${descriptor.role}.`
    : `Imported from OpenClaw agent folder ${descriptor.agentName}.`
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

function buildGeneratedIdentity(identityKey, agentName) {
  const keys = createIdentityPublicKey()
  const domain = agentName === 'clara' || agentName === 'fischer'
    ? 'coppen.beam.directory'
    : 'openclaw.beam.directory'
  return {
    agentName,
    identityKey,
    orgName: 'openclaw',
    beamId: `${slugify(agentName)}@${domain}`,
    ...keys,
    directoryUrl,
  }
}

async function runImportCycle(existingSession = null, allowRefresh = true) {
  const [baseIdentities, generatedIdentities] = await Promise.all([
    readJsonFile(identitiesPath, {}),
    readJsonFile(generatedIdentitiesPath, {}),
  ])

  const { descriptors, counts } = await listOpenClawDescriptors()
  const session = existingSession ?? await createAdminToken()
  const { token, magicUrl } = session
  const adminHeaders = createAdminHeaders(token)
  try {
    await ensureWorkspace(adminHeaders)

    const generatedUpdates = { ...generatedIdentities }
    const imported = []
    const registered = []
    const missing = []
    let originalPolicy = null

    try {
      if (registerMissing) {
        originalPolicy = await getPublicEndpointPolicy(adminHeaders)
        const trustedIps = [...new Set([...(originalPolicy.trustedIps ?? []), '127.0.0.1', '::1', 'unknown'])]
        await patchPublicEndpointPolicy(adminHeaders, {
          trustedIps,
          registrationPerMinute: Math.max(originalPolicy.registrationPerMinute ?? 10, descriptors.length + 10),
        })
      }

      for (const descriptor of descriptors) {
        const markdown = descriptor.rootDir
          ? await readAgentMarkdown(descriptor.rootDir, descriptor.agentName)
          : ''
        const displayName = descriptor.displayName ?? extractDisplayName(descriptor.agentName, markdown)
        const role = descriptor.role ?? extractRole(markdown)
        let identity = generatedUpdates[descriptor.identityKey]
          ?? baseIdentities[descriptor.identityKey]
          ?? generatedUpdates[descriptor.agentName]
          ?? baseIdentities[descriptor.agentName]
          ?? null

        if (!identity && registerMissing) {
          identity = buildGeneratedIdentity(descriptor.identityKey, descriptor.agentName)
          generatedUpdates[descriptor.identityKey] = identity
        }

        if (!identity) {
          missing.push({
            agentName: descriptor.agentName,
            displayName,
            role,
          })
          continue
        }

        const description = role
          ? `Imported OpenClaw agent. ${role}`
          : 'Imported OpenClaw agent.'
        const registration = await ensureDirectoryAgent(identity, displayName, description)
        if (registration.apiKey) {
          generatedUpdates[descriptor.identityKey] = {
            ...identity,
            agentName: descriptor.agentName,
            identityKey: descriptor.identityKey,
            directoryUrl,
            apiKey: registration.apiKey,
          }
        }

        const binding = await ensureBinding(adminHeaders, {
          ...identity,
          beamId: registration.agent.beamId ?? registration.agent.beam_id ?? identity.beamId,
        }, {
          ...descriptor,
          role,
        })

        imported.push({
          agentName: descriptor.agentName,
          displayName,
          beamId: binding.beamId ?? identity.beamId,
          bindingId: binding.id,
        })

        if (registration.registeredNow) {
          registered.push({
            agentName: descriptor.agentName,
            beamId: binding.beamId ?? identity.beamId,
          })
        }
      }
    } finally {
      if (originalPolicy) {
        await patchPublicEndpointPolicy(adminHeaders, originalPolicy)
      }
    }

    await mkdir(path.dirname(generatedIdentitiesPath), { recursive: true })
    await writeFile(generatedIdentitiesPath, `${JSON.stringify(generatedUpdates, null, 2)}\n`, 'utf8')
    await writeFile(mergedIdentitiesPath, `${JSON.stringify({ ...baseIdentities, ...generatedUpdates }, null, 2)}\n`, 'utf8')

    return {
      session,
      magicUrl,
      descriptors,
      counts,
      imported,
      registered,
      missing,
    }
  } catch (error) {
    const message = formatErrorMessage(error)
    const looksLikeAuthFailure = message.includes(' 401:') || message.includes(' 403:')
    if (allowRefresh && existingSession && looksLikeAuthFailure) {
      return runImportCycle(await createAdminToken(), false)
    }
    throw error
  }
}

function printCycleSummary(summary) {
  const {
    magicUrl,
    descriptors,
    counts,
    imported,
    registered,
    missing,
  } = summary

  console.log('')
  console.log('Beam OpenClaw import finished.')
  console.log('')
  console.log(`Login link:       ${magicUrl}`)
  console.log(`Workspace page:   ${dashboardUrl}/workspaces?workspace=${encodeURIComponent(workspaceSlug)}`)
  console.log(`Discovered:       ${descriptors.length}`)
  console.log(`- persistent:     ${counts.persistentAgents}`)
  console.log(`- workspace:      ${counts.workspaceAgents}`)
  console.log(`- subagents:      ${counts.subagents}`)
  console.log(`Imported:         ${imported.length}`)
  console.log(`Registered new:   ${registered.length}`)
  console.log(`Missing identity: ${missing.length}`)
  console.log(`Generated file:   ${generatedIdentitiesPath}`)
  console.log(`Merged file:      ${mergedIdentitiesPath}`)
  console.log('')

  if (registered.length > 0) {
    console.log('Newly registered agents:')
    for (const item of registered.slice(0, 20)) {
      console.log(`- ${item.agentName} -> ${item.beamId}`)
    }
    if (registered.length > 20) {
      console.log(`- ... and ${registered.length - 20} more`)
    }
    console.log('')
  }

  if (missing.length > 0) {
    console.log('Missing Beam identities:')
    for (const item of missing.slice(0, 20)) {
      console.log(`- ${item.agentName}${item.role ? ` (${item.role})` : ''}`)
    }
    if (missing.length > 20) {
      console.log(`- ... and ${missing.length - 20} more`)
    }
    console.log('')
    console.log('Run again with --register-missing to generate local Beam identities for them.')
    console.log('')
  }

  console.log('To let OpenClaw send with the imported local identities, point the sender to:')
  console.log(`BEAM_IDENTITIES=${mergedIdentitiesPath}`)
  console.log(`BEAM_DIRECTORY_URL=${directoryUrl}`)
}

async function main() {
  if (!watchMode) {
    printCycleSummary(await runImportCycle())
    return
  }

  console.log(`Beam OpenClaw watch mode active for workspace "${workspaceSlug}".`)
  console.log(`Watching OpenClaw state files for new agents or subagent runs.`)

  let lastFingerprint = ''
  let activeSession = null
  let syncTimer = null
  let syncRunning = false
  let syncQueued = false

  const triggerSync = (reason) => {
    if (syncTimer) {
      clearTimeout(syncTimer)
    }
    syncTimer = setTimeout(() => {
      syncTimer = null
      void runSync(reason)
    }, watchDebounceMs)
  }

  const runSync = async (reason) => {
    if (syncRunning) {
      syncQueued = true
      return
    }

    const currentFingerprint = sourceFingerprint()
    if (currentFingerprint === lastFingerprint && reason !== 'startup') {
      return
    }

    syncRunning = true
    try {
      if (lastFingerprint !== '') {
        console.log('')
        console.log(`[watch] change detected (${reason}), syncing Beam workspace roster...`)
      }
      const summary = await runImportCycle(activeSession)
      activeSession = summary.session
      lastFingerprint = sourceFingerprint()
      printCycleSummary(summary)
      console.log('')
      console.log('[watch] waiting for the next OpenClaw change...')
    } catch (error) {
      console.error(formatErrorMessage(error))
      console.log('[watch] sync failed; keeping watcher alive and retrying on the next change.')
    } finally {
      syncRunning = false
      if (syncQueued) {
        syncQueued = false
        triggerSync('queued-change')
      }
    }
  }

  const watchTargets = [
    { path: agentsDir, kind: 'directory' },
    { path: workspaceAgentsDir, kind: 'directory' },
    { path: path.dirname(subagentRunsPath), kind: 'file-parent', file: path.basename(subagentRunsPath) },
    { path: path.dirname(identitiesPath), kind: 'file-parent', file: path.basename(identitiesPath) },
    { path: path.dirname(generatedIdentitiesPath), kind: 'file-parent', file: path.basename(generatedIdentitiesPath) },
  ].filter((target) => fs.existsSync(target.path))

  const watchers = watchTargets.map((target) => fs.watch(target.path, (_eventType, filename) => {
    if (target.kind === 'file-parent' && filename && filename !== target.file) {
      return
    }
    triggerSync(target.kind === 'file-parent' ? target.file : path.basename(target.path))
  }))

  const shutdown = () => {
    for (const watcher of watchers) {
      watcher.close()
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await runSync('startup')
  await new Promise(() => {})
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
