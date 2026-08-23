import { BeamClient, BeamIdentity, type BeamIdString } from '../packages/sdk-typescript/dist/index.js'

export { BeamClient, BeamIdentity }
export type { BeamIdString }

export const directoryUrl = process.env.BEAM_DIRECTORY_URL ?? 'http://localhost:3100'
let aclAdminTokenPromise: Promise<string> | null = null

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

export async function createRegisteredClient(options: {
  prefix: string
  displayName: string
  capabilities: string[]
}): Promise<BeamClient> {
  const identity = BeamIdentity.generate({
    agentName: `${options.prefix}-${randomSuffix()}`,
    orgName: 'examples',
  })

  const client = new BeamClient({
    identity: identity.export(),
    directoryUrl,
  })

  await client.register(options.displayName, options.capabilities)
  return client
}

export async function allowIntent(options: {
  targetBeamId: BeamIdString
  intentType: string
  allowedFrom: BeamIdString | '*'
}): Promise<void> {
  const adminToken = await getAclAdminToken()
  const response = await fetch(`${directoryUrl.replace(/\/$/, '')}/acl`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  })

  if (!response.ok) {
    throw new Error(`Failed to create ACL for ${options.intentType}: ${response.status} ${response.statusText}`)
  }
}

async function getAclAdminToken(): Promise<string> {
  const configuredToken = process.env.BEAM_ADMIN_TOKEN?.trim()
  if (configuredToken) {
    return configuredToken
  }

  if (!aclAdminTokenPromise) {
    aclAdminTokenPromise = createLocalAdminToken().catch((error) => {
      aclAdminTokenPromise = null
      throw error
    })
  }
  return aclAdminTokenPromise
}

async function createLocalAdminToken(): Promise<string> {
  const adminEmail = process.env.BEAM_ADMIN_EMAIL?.trim()
  if (!adminEmail) {
    throw new Error('ACL setup requires BEAM_ADMIN_TOKEN, or BEAM_ADMIN_EMAIL for a local development directory')
  }

  const baseUrl = directoryUrl.replace(/\/$/, '')
  const challengeResponse = await fetch(`${baseUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ email: adminEmail }),
  })
  const challenge = await challengeResponse.json() as { token?: string; error?: string }
  if (!challengeResponse.ok) {
    throw new Error(`Failed to create an ACL admin session: ${challenge.error ?? challengeResponse.statusText}`)
  }
  if (!challenge.token) {
    throw new Error('The directory did not expose a local development token; set BEAM_ADMIN_TOKEN explicitly')
  }

  const verifyResponse = await fetch(`${baseUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })
  const verified = await verifyResponse.json() as { token?: string; error?: string }
  if (!verifyResponse.ok || !verified.token) {
    throw new Error(`Failed to verify the ACL admin session: ${verified.error ?? verifyResponse.statusText}`)
  }
  return verified.token
}

export function shutdown(...clients: BeamClient[]): void {
  for (const client of clients) {
    client.disconnect()
  }
}
