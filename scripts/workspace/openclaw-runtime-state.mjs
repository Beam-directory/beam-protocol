import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadOpenClawIdentityState, readJsonFile } from './openclaw-secret-store.mjs'

export function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
}

export function capitalize(value) {
  return value.length > 0
    ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
    : value
}

export function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

export function directoryFingerprint(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return ''
  }

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${entry.name}:${fileMtimeMs(path.join(rootDir, entry.name))}`)
    .sort((left, right) => left.localeCompare(right))
    .join('|')
}

export function parseAgentNameFromSessionKey(sessionKey) {
  const match = typeof sessionKey === 'string'
    ? sessionKey.match(/^agent:([^:]+):/u)
    : null
  return match?.[1] ?? 'openclaw'
}

export function parseSubagentIdFromSessionKey(sessionKey) {
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

export function openClawRouteKeyForDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    return null
  }

  if (descriptor.source === 'subagent-run') {
    return descriptor.childSessionKey || `subagent:${descriptor.runId || descriptor.identityKey || descriptor.agentName || 'unknown'}`
  }

  if (descriptor.source === 'workspace-agent') {
    return `workspace:${descriptor.agentName}`
  }

  if (descriptor.source === 'gateway-agent') {
    return `gateway:${descriptor.agentName}`
  }

  return `agent:${descriptor.agentName}`
}

export function resolveRuntimePaths(overrides = {}) {
  const home = os.homedir()
  return {
    agentsDir: overrides.agentsDir ?? path.join(home, '.openclaw/agents'),
    workspaceAgentsDir: overrides.workspaceAgentsDir ?? path.join(home, '.openclaw/workspace/agents'),
    identitiesPath: overrides.identitiesPath ?? path.join(home, '.openclaw/workspace/secrets/beam-identities.json'),
    generatedIdentitiesPath: overrides.generatedIdentitiesPath ?? path.join(home, '.openclaw/workspace/secrets/beam-identities.generated.json'),
    mergedIdentitiesPath: overrides.mergedIdentitiesPath ?? path.join(home, '.openclaw/workspace/secrets/beam-identities.merged.json'),
    subagentRunsPath: overrides.subagentRunsPath ?? path.join(home, '.openclaw/subagents/runs.json'),
  }
}

export function runtimeSourceFingerprint(paths) {
  return JSON.stringify({
    agentsDir: directoryFingerprint(paths.agentsDir),
    workspaceAgentsDir: directoryFingerprint(paths.workspaceAgentsDir),
    identitiesPath: fileMtimeMs(paths.identitiesPath),
    generatedIdentitiesPath: fileMtimeMs(paths.generatedIdentitiesPath),
    mergedIdentitiesPath: fileMtimeMs(paths.mergedIdentitiesPath),
    subagentRunsPath: fileMtimeMs(paths.subagentRunsPath),
  })
}

function resolveOpenClawBinary() {
  const candidates = [
    process.env.OPENCLAW_BIN,
    path.join(process.env.HOME ?? '', 'Library/pnpm/openclaw'),
    '/Users/tobik/Library/pnpm/openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }

  const which = spawnSync('/usr/bin/which', ['openclaw'], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  })
  if (which.status === 0) {
    const resolved = which.stdout.trim()
    if (resolved.length > 0) {
      return resolved
    }
  }

  return 'openclaw'
}

const gatewayPath = [...new Set([
  path.dirname(process.execPath),
  path.join(process.env.HOME ?? '', 'Library/pnpm'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.PATH,
].filter(Boolean))].join(':')

function readGatewayAgentDescriptors() {
  const result = spawnSync(resolveOpenClawBinary(), ['gateway', 'call', 'health', '--json'], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: gatewayPath,
    },
  })

  if (result.status !== 0) {
    return []
  }

  try {
    const payload = JSON.parse(result.stdout)
    const agents = Array.isArray(payload?.agents) ? payload.agents : []
    return agents
      .map((agent) => {
        const agentName = typeof agent?.agentId === 'string' ? agent.agentId.trim() : ''
        if (agentName.length === 0) {
          return null
        }
        return {
          agentName,
          identityKey: agentName,
          source: 'gateway-agent',
          rootDir: null,
          runtimeType: `openclaw:${agentName}`,
          role: null,
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.agentName.localeCompare(right.agentName))
  } catch {
    return []
  }
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

function normalizeSubagentDescriptors(runsPayload, { subagentDays = 30, subagentLimit = 50, includeEndedSubagents = false } = {}) {
  const runs = Object.values(runsPayload?.runs ?? {})
  const cutoff = Number.isFinite(subagentDays) && subagentDays > 0
    ? Date.now() - (subagentDays * 24 * 60 * 60 * 1000)
    : 0
  const limit = Number.isFinite(subagentLimit) && subagentLimit > 0 ? subagentLimit : 50

  return runs
    .map((run) => {
      const childSessionKey = typeof run.childSessionKey === 'string' ? run.childSessionKey : null
      const subagentId = parseSubagentIdFromSessionKey(childSessionKey)
      if (!subagentId) {
        return null
      }

      const endedAt = typeof run.endedAt === 'number' ? run.endedAt : null
      if (!includeEndedSubagents && endedAt !== null) {
        return null
      }

      const createdAt = typeof run.createdAt === 'number' ? run.createdAt : null
      const referenceTime = endedAt ?? createdAt ?? 0
      if (referenceTime < cutoff) {
        return null
      }

      const controllerAgent = parseAgentNameFromSessionKey(run.controllerSessionKey)
      const shortId = subagentId.slice(0, 8)
      const normalizedLabel = typeof run.label === 'string' && run.label.trim().length > 0 ? run.label.trim() : null
      const taskPreview = typeof run.task === 'string'
        ? run.task.replace(/\s+/gu, ' ').trim().slice(0, 160)
        : null

      return {
        agentName: normalizedLabel
          ? `${controllerAgent}-${slugify(normalizedLabel)}`
          : `${controllerAgent}-subagent-${shortId}`,
        identityKey: `subagent-${controllerAgent}-${shortId}`,
        source: 'subagent-run',
        rootDir: null,
        runtimeType: `openclaw-subagent:${controllerAgent}`,
        role: normalizedLabel ? `Subagent (${normalizedLabel}) of ${controllerAgent}` : `Subagent of ${controllerAgent}`,
        controllerAgent,
        label: normalizedLabel,
        runId: typeof run.runId === 'string' ? run.runId : shortId,
        taskPreview,
        displayName: normalizedLabel
          ? `${capitalize(controllerAgent)} Subagent (${normalizedLabel})`
          : `${capitalize(controllerAgent)} Subagent ${shortId}`,
        createdAt,
        endedAt,
        childSessionKey,
        controllerSessionKey: typeof run.controllerSessionKey === 'string' ? run.controllerSessionKey : null,
      }
    })
    .filter(Boolean)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, limit)
}

export async function listOpenClawRuntimeDescriptors(options = {}) {
  const paths = resolveRuntimePaths(options)
  const persistentAgents = listAgentDirectories(paths.agentsDir, 'agent-folder')
  const workspaceAgents = listAgentDirectories(paths.workspaceAgentsDir, 'workspace-agent')
  const gatewayAgents = readGatewayAgentDescriptors()
  const subagents = options.includeSubagents === false
    ? []
    : normalizeSubagentDescriptors(
        await readJsonFile(paths.subagentRunsPath, { version: 0, runs: {} }),
        {
          subagentDays: options.subagentDays,
          subagentLimit: options.subagentLimit,
          includeEndedSubagents: options.includeEndedSubagents,
        }
      )

  const descriptors = new Map()
  for (const descriptor of [...persistentAgents, ...workspaceAgents, ...gatewayAgents, ...subagents]) {
    if (!descriptors.has(descriptor.identityKey)) {
      descriptors.set(descriptor.identityKey, descriptor)
    }
  }

  return {
    paths,
    descriptors: [...descriptors.values()],
    counts: {
      persistentAgents: persistentAgents.length,
      workspaceAgents: workspaceAgents.length,
      gatewayAgents: gatewayAgents.length,
      subagents: subagents.length,
    },
  }
}

export async function loadOpenClawRuntimeState(options = {}) {
  const paths = resolveRuntimePaths(options)
  const {
    baseIdentities,
    generatedIdentities,
    secretStorage,
  } = await loadOpenClawIdentityState({
    identitiesPath: paths.identitiesPath,
    generatedIdentitiesPath: paths.generatedIdentitiesPath,
    mergedIdentitiesPath: paths.mergedIdentitiesPath,
  })
  const { descriptors, counts } = await listOpenClawRuntimeDescriptors({
    ...options,
    ...paths,
  })

  const identities = {
    ...baseIdentities,
    ...generatedIdentities,
  }

  const routes = descriptors
    .map((descriptor) => {
      const identity = identities[descriptor.identityKey]
        ?? identities[descriptor.agentName]
        ?? null
      if (!identity || typeof identity.beamId !== 'string' || typeof identity.apiKey !== 'string') {
        return null
      }

      return {
        ...descriptor,
        beamId: identity.beamId,
        apiKey: identity.apiKey,
        publicKeyBase64: identity.publicKeyBase64 ?? null,
        privateKeyBase64: identity.privateKeyBase64 ?? null,
        directoryUrl: identity.directoryUrl ?? null,
      }
    })
    .filter(Boolean)

  return {
    paths,
    counts,
    descriptors,
    identities,
    routes,
    secretStorage,
    fingerprint: runtimeSourceFingerprint(paths),
  }
}
