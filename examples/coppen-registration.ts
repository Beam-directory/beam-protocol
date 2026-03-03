/**
 * Beam Protocol — COPPEN GmbH Agent Registration
 *
 * This example demonstrates how to register the first three COPPEN agents
 * with a Beam Directory and send an intent between them.
 *
 * Run: npx tsx examples/coppen-registration.ts
 */

import { BeamIdentity, BeamClient, BeamDirectory } from '../packages/sdk-typescript/src/index.js'
import type { BeamIdString } from '../packages/sdk-typescript/src/index.js'

const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL ?? 'http://localhost:3100'

// ─────────────────────────────────────────────────
// 1. Generate identities for COPPEN agents
// ─────────────────────────────────────────────────

const jarvis = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
const fischer = BeamIdentity.generate({ agentName: 'fischer', orgName: 'coppen' })
const clara = BeamIdentity.generate({ agentName: 'clara', orgName: 'coppen' })

console.log('🔑 Identities generated:')
console.log(`   ${jarvis.beamId}  (Directory Admin, Orchestration, Memory)`)
console.log(`   ${fischer.beamId} (Forderungen, Invoicing, Customer Communication)`)
console.log(`   ${clara.beamId}   (Customer Service, Scheduling, Callbacks)`)
console.log()

// ─────────────────────────────────────────────────
// 2. Register all agents with the Directory
// ─────────────────────────────────────────────────

const directory = new BeamDirectory({ baseUrl: DIRECTORY_URL })

async function registerAgents(): Promise<void> {
  console.log('📡 Registering agents with Beam Directory...')

  const jarvisRecord = await directory.register({
    beamId: jarvis.beamId,
    displayName: 'Jarvis',
    capabilities: ['directory-admin', 'orchestration', 'memory', 'scheduling'],
    publicKey: jarvis.publicKeyBase64,
    org: 'coppen'
  }) as any
  console.log(`   ✅ ${jarvisRecord.beam_id} — Trust: ${jarvisRecord.trust_score}`)

  const fischerRecord = await directory.register({
    beamId: fischer.beamId,
    displayName: 'Marc Fischer',
    capabilities: ['forderungen', 'invoicing', 'customer-communication', 'payments'],
    publicKey: fischer.publicKeyBase64,
    org: 'coppen'
  }) as any
  console.log(`   ✅ ${fischerRecord.beam_id} — Trust: ${fischerRecord.trust_score}`)

  const claraRecord = await directory.register({
    beamId: clara.beamId,
    displayName: 'Clara',
    capabilities: ['customer-service', 'scheduling', 'callbacks', 'voice'],
    publicKey: clara.publicKeyBase64,
    org: 'coppen'
  }) as any
  console.log(`   ✅ ${claraRecord.beam_id} — Trust: ${claraRecord.trust_score}`)

  console.log()
}

// ─────────────────────────────────────────────────
// 3. Search for COPPEN agents by capability
// ─────────────────────────────────────────────────

async function searchDemo(): Promise<void> {
  console.log('🔍 Searching for invoicing agents at COPPEN...')
  const searchResult = await directory.search({ org: 'coppen', capabilities: ['invoicing'] }) as any
  const agents = searchResult.agents ?? searchResult
  for (const agent of agents) {
    console.log(`   Found: ${agent.beam_id} (${agent.display_name}) — Capabilities: ${JSON.stringify(agent.capabilities)}`)
  }
  console.log()
}

// ─────────────────────────────────────────────────
// 4. Send an intent: Jarvis → Fischer
// ─────────────────────────────────────────────────

async function intentDemo(): Promise<void> {
  console.log('📨 Sending intent: Jarvis → Fischer (query.invoice)')

  // Create clients
  const jarvisClient = new BeamClient({
    identity: jarvis.export(),
    directoryUrl: DIRECTORY_URL
  })

  const fischerClient = new BeamClient({
    identity: fischer.export(),
    directoryUrl: DIRECTORY_URL
  })

  // Fischer listens for invoice queries
  fischerClient.on('query.invoice', (frame, respond) => {
    console.log(`   📥 Fischer received: ${frame.intent} from ${frame.from}`)
    console.log(`      Params: ${JSON.stringify(frame.params)}`)

    // Simulate invoice lookup
    respond({
      success: true,
      payload: {
        invoice: {
          id: frame.params['invoice_id'] as string,
          amount: 4200.00,
          currency: 'EUR',
          status: 'pending',
          customer: 'Max Mustermann',
          project: 'PV-0001'
        }
      }
    })
  })

  // Connect both to directory
  await Promise.all([
    jarvisClient.connect(),
    fischerClient.connect()
  ])

  console.log('   🔗 Both agents connected to directory')

  // Jarvis sends intent to Fischer
  const result = await jarvisClient.send(
    fischer.beamId,
    'query.invoice',
    { invoice_id: 'INV-2026-001' }
  )

  console.log(`   📤 Result received:`)
  console.log(`      Success: ${result.success}`)
  console.log(`      Latency: ${result.latency}ms`)
  if (result.payload) {
    console.log(`      Invoice: ${JSON.stringify(result.payload['invoice'], null, 2)}`)
  }

  // Cleanup
  jarvisClient.disconnect()
  fischerClient.disconnect()
  console.log()
}

// ─────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════')
  console.log('  Beam Protocol — COPPEN Agent Registration')
  console.log('  "SMTP für KI-Agenten"')
  console.log('═══════════════════════════════════════════')
  console.log()

  await registerAgents()
  await searchDemo()

  try {
    await intentDemo()
  } catch (err) {
    console.log(`   ⚠️  Intent demo requires running directory server.`)
    console.log(`      Start with: cd packages/directory && npm start`)
    console.log(`      Error: ${(err as Error).message}`)
  }

  console.log('✨ Done! COPPEN agents are registered in the Beam Directory.')
  console.log()
  console.log('Beam IDs:')
  console.log(`   🤖 ${jarvis.beamId}`)
  console.log(`   ⚖️  ${fischer.beamId}`)
  console.log(`   📞 ${clara.beamId}`)
}

main().catch(console.error)
