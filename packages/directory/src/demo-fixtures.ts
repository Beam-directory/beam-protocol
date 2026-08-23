import { isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { beamIdFromApiKey, hashApiKey } from './api-key.js'
import {
  createOrg,
  getAgent,
  getOrg,
  markAgentDomainVerified,
  markOrgVerified,
  registerAgent,
} from './db.js'

type DemoIdentity = {
  beamId: string
  publicKeyBase64: string
  apiKey: string
}

type DemoIdentityBundle = Record<string, DemoIdentity>

const DEMO_AGENT_PROFILES: Record<string, { displayName: string; capabilities: string[] }> = {
  procurement: { displayName: 'Acme Procurement Desk', capabilities: ['quote.request'] },
  partnerDesk: { displayName: 'Northwind Partner Desk', capabilities: ['quote.request', 'inventory.check'] },
  warehouse: { displayName: 'Northwind Warehouse', capabilities: ['inventory.check'] },
  finance: { displayName: 'Acme Finance Desk', capabilities: ['purchase.preflight'] },
}

function assertLoopbackPublicUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Demo fixtures require PUBLIC_BASE_URL to be a valid loopback URL')
  }

  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Demo fixtures are restricted to a loopback PUBLIC_BASE_URL')
  }
}

function loadBundle(path: string): DemoIdentityBundle {
  if (!isAbsolute(path)) {
    throw new Error('BEAM_DEMO_FIXTURE_PATH must be an absolute path')
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Demo fixture bundle must be a JSON object')
  }
  return parsed as DemoIdentityBundle
}

function assertDemoIdentity(key: string, identity: DemoIdentity): void {
  if (
    !identity
    || typeof identity.beamId !== 'string'
    || typeof identity.publicKeyBase64 !== 'string'
    || typeof identity.apiKey !== 'string'
  ) {
    throw new Error(`Demo fixture ${key} is missing beamId, publicKeyBase64, or apiKey`)
  }
  if (beamIdFromApiKey(identity.apiKey) !== identity.beamId) {
    throw new Error(`Demo fixture ${key} API key is not bound to ${identity.beamId}`)
  }
}

export function seedDemoFixturesFromEnvironment(db: Database): boolean {
  if (process.env['BEAM_ENABLE_DEMO_FIXTURES'] !== 'true') {
    return false
  }

  assertLoopbackPublicUrl(process.env['PUBLIC_BASE_URL'] ?? '')
  const fixturePath = process.env['BEAM_DEMO_FIXTURE_PATH']?.trim()
  if (!fixturePath) {
    throw new Error('BEAM_DEMO_FIXTURE_PATH is required when demo fixtures are enabled')
  }
  const identities = loadBundle(fixturePath)

  db.transaction(() => {
    for (const org of [
      { name: 'acme', displayName: 'Acme', domain: 'acme.example' },
      { name: 'northwind', displayName: 'Northwind', domain: 'northwind.example' },
    ]) {
      const existing = getOrg(db, org.name)
      if (!existing) {
        createOrg(db, {
          ...org,
          apiKeyHash: hashApiKey(`beam_org_${org.name}_local_demo_only`),
          verificationToken: `${org.name}-local-demo-only`,
        })
      } else if (existing.domain !== org.domain) {
        throw new Error(`Refusing to replace existing organization ${org.name} with a demo fixture`)
      }
      markOrgVerified(db, org.name)
    }

    for (const [key, profile] of Object.entries(DEMO_AGENT_PROFILES)) {
      const identity = identities[key]
      assertDemoIdentity(key, identity)
      const org = identity.beamId.split('@')[1]?.replace(/\.beam\.directory$/, '') ?? ''
      const existing = getAgent(db, identity.beamId)
      const apiKeyHash = hashApiKey(identity.apiKey)

      if (!existing) {
        registerAgent(db, {
          beamId: identity.beamId,
          displayName: profile.displayName,
          capabilities: profile.capabilities,
          publicKey: identity.publicKeyBase64,
          apiKeyHash,
          org,
          personal: false,
          visibility: 'public',
        })
      } else if (existing.public_key !== identity.publicKeyBase64) {
        throw new Error(`Refusing to replace existing Beam identity ${identity.beamId} with a demo fixture`)
      } else if (existing.api_key_hash !== apiKeyHash) {
        // Upgrade older quickstart volumes that registered the same checked-in
        // signing identity with a one-off API key. This mutation is reachable
        // only behind the explicit loopback-only demo-fixture gate above.
        db.prepare('UPDATE agents SET api_key_hash = ? WHERE beam_id = ?').run(apiKeyHash, identity.beamId)
      }

      markAgentDomainVerified(db, identity.beamId)
    }
  })()

  return true
}
