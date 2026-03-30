import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const envPath = path.join(repoRoot, 'ops/quickstart/.env')

export function parseEnvFile(raw) {
  const env = {}
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

export async function loadQuickstartEnv() {
  try {
    const raw = await readFile(envPath, 'utf8')
    return parseEnvFile(raw)
  } catch {
    return {}
  }
}

export function resolveRuntime(config = {}) {
  const directoryPort = config.DIRECTORY_PORT ?? process.env.DIRECTORY_PORT ?? '43100'
  const dashboardPort = config.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? '43173'
  const messageBusPort = config.MESSAGE_BUS_PORT ?? process.env.MESSAGE_BUS_PORT ?? '43220'
  const demoAgentPort = config.DEMO_AGENT_PORT ?? process.env.DEMO_AGENT_PORT ?? '43290'
  const adminEmailList = config.BEAM_ADMIN_EMAILS ?? process.env.BEAM_ADMIN_EMAILS ?? 'ops@beam.local'
  const [adminEmail = 'ops@beam.local'] = adminEmailList
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    adminEmail,
    busApiKey: config.BEAM_BUS_API_KEY ?? process.env.BEAM_BUS_API_KEY ?? 'beam-local-bus-key',
    directoryUrl: `http://127.0.0.1:${directoryPort}`,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    messageBusBaseUrl: `http://127.0.0.1:${messageBusPort}`,
    messageBusUrl: `http://127.0.0.1:${messageBusPort}/v1/beam`,
    demoAgentUrl: `http://127.0.0.1:${demoAgentPort}`,
  }
}

export async function waitForHealth(url, label, predicate = (response) => response.ok, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) {
        return response
      }
    } catch {
      // Wait until the service is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`${label} did not become ready at ${url}`)
}

export async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  const payload = text.length > 0 ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return payload
}

export async function createAdminToken(directoryUrl, dashboardUrl, adminEmail) {
  const challenge = await requestJson(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: dashboardUrl.replace('127.0.0.1', 'localhost'),
    },
    body: JSON.stringify({ email: adminEmail }),
  })

  const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  return verify.token
}
