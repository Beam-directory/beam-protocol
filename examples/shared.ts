import { BeamClient, BeamIdentity, type BeamIdString } from '../packages/sdk-typescript/dist/index.js'

export { BeamClient, BeamIdentity }
export type { BeamIdString }

export const directoryUrl = process.env.BEAM_DIRECTORY_URL ?? 'http://localhost:3100'

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
  const response = await fetch(`${directoryUrl.replace(/\/$/, '')}/acl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })

  if (!response.ok) {
    throw new Error(`Failed to create ACL for ${options.intentType}: ${response.status} ${response.statusText}`)
  }
}

export function shutdown(...clients: BeamClient[]): void {
  for (const client of clients) {
    client.disconnect()
  }
}
