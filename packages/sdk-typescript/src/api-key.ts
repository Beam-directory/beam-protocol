const AGENT_API_KEY_PREFIX = 'bk_'

function normalizeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (normalized.length % 4)) % 4
  return normalized.padEnd(normalized.length + padding, '=')
}

function base64ToUtf8(base64: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64').toString('utf8')
  }

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder().decode(bytes)
}

export function beamIdFromApiKey(apiKey: string): string | null {
  if (!apiKey.startsWith(AGENT_API_KEY_PREFIX)) {
    return null
  }

  const encodedBeamId = apiKey.slice(AGENT_API_KEY_PREFIX.length).split('.', 1)[0] ?? ''
  if (!encodedBeamId) {
    return null
  }

  try {
    const beamId = base64ToUtf8(normalizeBase64Url(encodedBeamId))
    return beamId || null
  } catch {
    return null
  }
}
