import { requestJson } from '../production/shared.mjs'

function mergeUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))]
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

async function getShieldConfig(directoryUrl, beamId) {
  const response = await requestJsonAllow(`${directoryUrl}/shield/config/${encodeURIComponent(beamId)}`, undefined, [404])
  if (response.status === 404) {
    return null
  }
  return response.payload?.shield ?? null
}

async function patchShieldConfig(directoryUrl, adminHeaders, beamId, shield) {
  await requestJson(`${directoryUrl}/shield/config/${encodeURIComponent(beamId)}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify(shield),
  })
}

function buildOpenClawShieldConfig(current) {
  const base = current ?? {
    mode: 'open',
    allowlist: [],
    blocklist: [],
    minTrust: 0.3,
    rateLimit: 20,
  }

  return {
    mode: base.mode === 'closed' ? 'open' : base.mode,
    allowlist: mergeUnique([...(base.allowlist ?? []), '*@openclaw.beam.directory']),
    blocklist: [...(base.blocklist ?? [])],
    minTrust: 0,
    rateLimit: Math.max(base.rateLimit ?? 20, 60),
  }
}

export async function ensureLocalOpenClawShield(directoryUrl, adminHeaders, beamId) {
  const current = await getShieldConfig(directoryUrl, beamId)
  if (!current) {
    return false
  }

  await patchShieldConfig(directoryUrl, adminHeaders, beamId, buildOpenClawShieldConfig(current))
  return true
}

export async function ensureLocalOpenClawRelayTargets(directoryUrl, adminHeaders) {
  const relayTargets = ['echo@beam.directory']
  for (const beamId of relayTargets) {
    await ensureLocalOpenClawShield(directoryUrl, adminHeaders, beamId)
  }
}

function extractDomainPatterns(beamIds) {
  return mergeUnique(
    beamIds
      .filter((beamId) => typeof beamId === 'string' && beamId.includes('@'))
      .map((beamId) => `*@${beamId.split('@').at(1)}`),
  )
}

async function createAcl(directoryUrl, adminHeaders, targetBeamId, intentType, allowedFrom) {
  await requestJson(`${directoryUrl}/acl`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      targetBeamId,
      intentType,
      allowedFrom,
    }),
  })
}

export async function ensureLocalOpenClawAcls(directoryUrl, adminHeaders, beamIds) {
  const localBeamIds = mergeUnique(beamIds)
  if (localBeamIds.length === 0) {
    return
  }

  const localDomainPatterns = extractDomainPatterns(localBeamIds)
  const relayTargets = ['echo@beam.directory']
  const relaySenders = ['echo@beam.directory']

  for (const targetBeamId of localBeamIds) {
    for (const allowedFrom of [...localDomainPatterns, ...relaySenders]) {
      await createAcl(directoryUrl, adminHeaders, targetBeamId, 'conversation.message', allowedFrom)
    }

    for (const allowedFrom of localDomainPatterns) {
      await createAcl(directoryUrl, adminHeaders, targetBeamId, 'task.delegate', allowedFrom)
    }
  }

  for (const targetBeamId of relayTargets) {
    for (const allowedFrom of localDomainPatterns) {
      await createAcl(directoryUrl, adminHeaders, targetBeamId, 'conversation.message', allowedFrom)
    }
  }
}
