#!/usr/bin/env node

// Runs coppen-trust-chain.mjs against a throwaway local directory with a test
// database: dry run, --apply, then the same run again to show it is idempotent.
// Never talks to production. Needs `npm run build --workspace=@beam-protocol/directory`.

import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  generatePersonKeyFile,
  loadPersonKey,
  parseConfig,
  runRevoke,
  runTrustChain,
} from './coppen-trust-chain.mjs'
import { createAdminToken, getFreePort, loadDirectoryDbModule, repoRoot, stopProcess, waitForHealth } from './shared.mjs'

export function ed25519Pair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/** Creates org `coppen` (domain-verified) and its agents, as they exist in production today. */
export async function seedCoppenFixture({ fetchImpl, base, markVerified, agentNames }) {
  const created = await fetchImpl(`${base}/orgs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.90' },
    body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
  })
  if (created.status !== 201) throw new Error(`creating org coppen failed with ${created.status}: ${await created.text()}`)
  const { apiKey, name } = await created.json()
  await markVerified(name)
  for (const agentName of agentNames) {
    const response = await fetchImpl(`${base}/orgs/coppen/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName, displayName: agentName, publicKey: ed25519Pair().publicKey }),
    })
    if (response.status !== 201) throw new Error(`creating agent ${agentName} failed with ${response.status}: ${await response.text()}`)
  }
  return { apiKey }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'coppen-trust-chain-'))
  const dbPath = path.join(tempRoot, 'directory.sqlite')
  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const issuer = ed25519Pair()
  const adminEmail = 'operator@beam.local'
  const directoryDbApi = await loadDirectoryDbModule()
  directoryDbApi.createDatabase(dbPath).close()

  const directory = spawn(process.execPath, [path.join(repoRoot, 'packages/directory/dist/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'coppen-trust-chain-local',
      BEAM_ADMIN_EMAILS: adminEmail,
      BEAM_DIRECTORY_URL: base,
      PUBLIC_BASE_URL: base,
      BEAM_DIRECTORY_SIGNING_PRIVATE_KEY: issuer.privateKey,
      BEAM_DIRECTORY_SIGNING_PUBLIC_KEY: issuer.publicKey,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  try {
    await waitForHealth(`${base}/health`, 'local directory')
    const rawConfig = JSON.parse(await readFile(path.join(repoRoot, 'scripts/production/coppen-trust-chain.config.json'), 'utf8'))
    const config = parseConfig(rawConfig)
    const { apiKey } = await seedCoppenFixture({
      fetchImpl: fetch,
      base,
      agentNames: config.agents.map((agent) => agent.agentName),
      markVerified: async (name) => {
        const db = directoryDbApi.createDatabase(dbPath)
        try {
          directoryDbApi.markOrgVerified(db, name)
        } finally {
          db.close()
        }
      },
    })
    const adminToken = await createAdminToken(base, adminEmail)
    const keyPath = path.join(tempRoot, 'tobias-person-key.json')
    generatePersonKeyFile(keyPath)
    const key = loadPersonKey(keyPath)
    const common = { config, key, directoryUrl: base, orgApiKey: apiKey, adminToken, issuerPublicKey: issuer.publicKey }

    console.log(`# Local directory ${base}, test DB ${dbPath}`)
    console.log('# Seeded: org coppen (coppen.de, verified) with agents jarvis, clara, fischer. No person, no mandate.\n')
    console.log('########## 1. Dry run (default) ##########\n')
    await runTrustChain({ ...common })
    console.log('\n########## 2. --apply ##########\n')
    const applied = await runTrustChain({ ...common, apply: true })
    console.log('\n########## 3. --apply again (idempotent) ##########\n')
    const again = await runTrustChain({ ...common, apply: true })
    console.log('\n########## 4. revoke, dry run ##########\n')
    await runRevoke({ config, key, directoryUrl: base, beamId: config.agents[0].beamId, jti: applied.results[0].mandate.jti, orgApiKey: apiKey })
    process.exitCode = applied.ok && again.ok ? 0 : 1
  } finally {
    await stopProcess(directory)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
