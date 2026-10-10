import { createPrivateKey, randomBytes, sign } from 'node:crypto'

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key])
    return sorted
  }
  return value
}

export function signedAgentConfigBody(privateKeyBase64, beamId, fields) {
  const body = {
    type: 'agent.config',
    beamId,
    ...fields,
    timestamp: new Date().toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  }
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(canonicalize(body)), 'utf8'),
    createPrivateKey({
      key: Buffer.from(privateKeyBase64.trim(), 'base64'),
      format: 'der',
      type: 'pkcs8',
    }),
  ).toString('base64')
  return { ...body, signature }
}
