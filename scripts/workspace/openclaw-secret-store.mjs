import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const keychainDisabled = process.env.BEAM_OPENCLAW_KEYCHAIN === '0'
const generatedIdentityService = 'com.beam.openclaw.generated-identity'
const adminSessionService = 'com.beam.openclaw.admin-session'
const hostConnectorService = 'com.beam.openclaw.host-connector'
const adminSessionAccount = 'default'
const hostConnectorAccount = 'default'

let keychainAvailableCache = null

export async function readJsonFile(filePath, fallback) {
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

async function ensurePrivateParent(filePath) {
  const dirPath = path.dirname(filePath)
  await mkdir(dirPath, { recursive: true, mode: 0o700 })
  try {
    await chmod(dirPath, 0o700)
  } catch {
    // Best effort only.
  }
}

export async function writePrivateJson(filePath, payload) {
  await ensurePrivateParent(filePath)
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await chmod(filePath, 0o600)
  } catch {
    // Best effort only.
  }
}

function runSecurity(args, { allowFailure = false } = {}) {
  const result = spawnSync('security', args, {
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  })

  if (result.status !== 0 && !allowFailure) {
    const details = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`security ${args.join(' ')} failed${details ? `: ${details}` : ''}`)
  }

  return result
}

function hasKeychainSupport() {
  if (keychainAvailableCache !== null) {
    return keychainAvailableCache
  }

  if (keychainDisabled || process.platform !== 'darwin') {
    keychainAvailableCache = false
    return keychainAvailableCache
  }

  try {
    const result = runSecurity(['help'], { allowFailure: true })
    keychainAvailableCache = result.status === 0 || result.status === 1
  } catch {
    keychainAvailableCache = false
  }

  return keychainAvailableCache
}

function readKeychainSecret(service, account) {
  if (!hasKeychainSupport()) {
    return null
  }

  const result = runSecurity(['find-generic-password', '-a', account, '-s', service, '-w'], { allowFailure: true })
  if (result.status !== 0) {
    return null
  }

  const value = result.stdout?.trim()
  return value && value.length > 0 ? value : null
}

function writeKeychainSecret(service, account, value) {
  if (!hasKeychainSupport()) {
    return false
  }

  const result = runSecurity(['add-generic-password', '-U', '-a', account, '-s', service, '-w', value], { allowFailure: true })
  return result.status === 0
}

function stripGeneratedIdentitySecrets(identity) {
  const { privateKeyBase64: _privateKeyBase64, apiKey: _apiKey, ...safe } = identity
  return safe
}

function loadGeneratedIdentitySecret(identityKey) {
  const raw = readKeychainSecret(generatedIdentityService, identityKey)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function storeGeneratedIdentitySecret(identityKey, identity) {
  const payload = JSON.stringify({
    privateKeyBase64: identity.privateKeyBase64 ?? null,
    apiKey: identity.apiKey ?? null,
    beamId: identity.beamId ?? null,
  })
  return writeKeychainSecret(generatedIdentityService, identityKey, payload)
}

export async function loadOpenClawIdentityState({
  identitiesPath,
  generatedIdentitiesPath,
  mergedIdentitiesPath,
}) {
  const baseIdentities = await readJsonFile(identitiesPath, {})
  const generatedMetadata = await readJsonFile(generatedIdentitiesPath, {})
  const generatedIdentities = {}

  for (const [identityKey, entry] of Object.entries(generatedMetadata)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    let resolved = { ...entry }
    if (!resolved.privateKeyBase64 || !resolved.apiKey) {
      const secret = loadGeneratedIdentitySecret(identityKey)
      if (secret) {
        resolved = {
          ...resolved,
          ...secret,
        }
      }
    }

    generatedIdentities[identityKey] = resolved
  }

  if (mergedIdentitiesPath) {
    await writePrivateJson(mergedIdentitiesPath, {
      ...baseIdentities,
      ...generatedIdentities,
    })
  }

  return {
    baseIdentities,
    generatedIdentities,
    generatedMetadata,
    secretStorage: hasKeychainSupport() ? 'keychain' : 'file',
  }
}

export async function persistOpenClawIdentityState({
  baseIdentities,
  generatedIdentities,
  generatedIdentitiesPath,
  mergedIdentitiesPath,
}) {
  const generatedMetadata = {}
  let secretStorage = hasKeychainSupport() ? 'keychain' : 'file'

  for (const [identityKey, identity] of Object.entries(generatedIdentities)) {
    if (!identity || typeof identity !== 'object') {
      continue
    }

    if (hasKeychainSupport() && storeGeneratedIdentitySecret(identityKey, identity)) {
      generatedMetadata[identityKey] = {
        ...stripGeneratedIdentitySecrets(identity),
        credentialStorage: 'keychain',
        credentialUpdatedAt: new Date().toISOString(),
      }
      continue
    }

    secretStorage = 'file'
    generatedMetadata[identityKey] = {
      ...identity,
      credentialStorage: 'file',
      credentialUpdatedAt: new Date().toISOString(),
    }
  }

  await writePrivateJson(generatedIdentitiesPath, generatedMetadata)
  const resolvedGeneratedIdentities = {}
  for (const [identityKey, entry] of Object.entries(generatedMetadata)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    let resolved = { ...entry }
    if (!resolved.privateKeyBase64 || !resolved.apiKey) {
      const secret = loadGeneratedIdentitySecret(identityKey)
      if (secret) {
        resolved = {
          ...resolved,
          ...secret,
        }
      }
    }

    resolvedGeneratedIdentities[identityKey] = resolved
  }

  await writePrivateJson(mergedIdentitiesPath, {
    ...baseIdentities,
    ...resolvedGeneratedIdentities,
  })

  return {
    generatedMetadata,
    secretStorage,
  }
}

export async function loadOpenClawAdminSession(sessionCachePath) {
  const keychainValue = readKeychainSecret(adminSessionService, adminSessionAccount)
  if (keychainValue) {
    try {
      return JSON.parse(keychainValue)
    } catch {
      return null
    }
  }

  return readJsonFile(sessionCachePath, null)
}

export async function storeOpenClawAdminSession(sessionCachePath, session) {
  if (hasKeychainSupport()) {
    const stored = writeKeychainSecret(adminSessionService, adminSessionAccount, JSON.stringify(session))
    if (stored) {
      await writePrivateJson(sessionCachePath, {
        createdAt: session.createdAt ?? Date.now(),
        credentialStorage: 'keychain',
      })
      return 'keychain'
    }
  }

  await writePrivateJson(sessionCachePath, session)
  return 'file'
}

export async function loadOpenClawHostConnectorState(statePath) {
  const metadata = await readJsonFile(statePath, null)
  const secretRaw = readKeychainSecret(hostConnectorService, hostConnectorAccount)
  let secretPayload = null
  if (secretRaw) {
    try {
      secretPayload = JSON.parse(secretRaw)
    } catch {
      secretPayload = null
    }
  }

  if (!metadata && !secretPayload) {
    return null
  }

  const resolved = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    ...(secretPayload && typeof secretPayload === 'object' ? secretPayload : {}),
  }

  return resolved
}

export async function storeOpenClawHostConnectorState(statePath, state) {
  const {
    credential,
    enrollmentToken,
    ...metadata
  } = state ?? {}

  if (hasKeychainSupport()) {
    const stored = writeKeychainSecret(hostConnectorService, hostConnectorAccount, JSON.stringify({
      credential: credential ?? null,
      enrollmentToken: enrollmentToken ?? null,
    }))
    if (stored) {
      await writePrivateJson(statePath, {
        ...metadata,
        credentialStorage: 'keychain',
        credentialUpdatedAt: new Date().toISOString(),
      })
      return 'keychain'
    }
  }

  await writePrivateJson(statePath, {
    ...metadata,
    credential: credential ?? null,
    enrollmentToken: enrollmentToken ?? null,
    credentialStorage: 'file',
    credentialUpdatedAt: new Date().toISOString(),
  })
  return 'file'
}
