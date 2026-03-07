/**
 * Beam Protocol Dogfood — COPPEN GmbH Agents
 * Register Jarvis, Fischer, Clara in the Directory
 * Then send a real Intent: Fischer → Jarvis "escalate case"
 */

import { BeamIdentity } from '../packages/sdk-typescript/src/identity.js'
import { BeamDirectory } from '../packages/sdk-typescript/src/directory.js'
import { BeamClient } from '../packages/sdk-typescript/src/client.js'

const DIRECTORY_URL = 'https://api.beam.directory'

async function main() {
  console.log('=== BEAM DOGFOOD: COPPEN GmbH ===\n')

  // 1. Generate identities for 3 COPPEN agents
  const jarvis = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'coppen' })
  const fischer = BeamIdentity.generate({ agentName: 'fischer', orgName: 'coppen' })
  const clara = BeamIdentity.generate({ agentName: 'clara', orgName: 'coppen' })

  console.log(`Jarvis:  ${jarvis.beamId}`)
  console.log(`Fischer: ${fischer.beamId}`)
  console.log(`Clara:   ${clara.beamId}`)
  console.log()

  // 2. Register all 3 with the Directory
  const directory = new BeamDirectory({ baseUrl: DIRECTORY_URL })

  console.log('Registering agents...')

  await directory.register({
    beamId: jarvis.beamId,
    displayName: 'Jarvis — Chief of Staff',
    capabilities: ['orchestration', 'email', 'calendar', 'memory', 'analytics', 'escalation-handler'],
    publicKey: jarvis.publicKeyBase64,
    org: 'coppen'
  })
  console.log('  ✅ Jarvis registered')

  await directory.register({
    beamId: fischer.beamId,
    displayName: 'Marc Fischer — Forderungsmanagement',
    capabilities: ['invoice-management', 'payment-tracking', 'customer-communication', 'escalation'],
    publicKey: fischer.publicKeyBase64,
    org: 'coppen'
  })
  console.log('  ✅ Fischer registered')

  await directory.register({
    beamId: clara.beamId,
    displayName: 'Clara — Vertrieb & Kundenservice',
    capabilities: ['voice-agent', 'customer-service', 'lead-qualification', 'callback-scheduling'],
    publicKey: clara.publicKeyBase64,
    org: 'coppen'
  })
  console.log('  ✅ Clara registered')

  // 3. Verify — search for COPPEN agents
  console.log('\nSearching for COPPEN agents...')
  const results = await directory.search({ org: 'coppen' })
  console.log(`  Found ${results.length} agents:`)
  for (const agent of results) {
    console.log(`    → ${agent.beamId} (${agent.displayName}) [${agent.capabilities?.join(', ')}]`)
  }

  // 4. Real Use Case: Fischer escalates to Jarvis
  console.log('\n=== USE CASE: Fischer → Jarvis Escalation ===\n')

  const fischerClient = new BeamClient({
    identity: fischer.export(),
    directoryUrl: DIRECTORY_URL
  })

  const jarvisClient = new BeamClient({
    identity: jarvis.export(),
    directoryUrl: DIRECTORY_URL
  })

  // Jarvis listens for escalations
  jarvisClient.on('forderung.escalate', (_frame, respond) => {
    console.log('  📨 Jarvis received escalation!')
    console.log(`     Customer: ${_frame.params?.customer}`)
    console.log(`     Amount: ${_frame.params?.amount}€`)
    console.log(`     Reason: ${_frame.params?.reason}`)

    respond({
      success: true,
      payload: {
        action: 'tobias-notified',
        priority: 'high',
        message: 'Tobias wird per WhatsApp informiert. Interne Klärung läuft.'
      }
    })
  })

  await jarvisClient.connect()
  await fischerClient.connect()

  console.log('  Fischer sends escalation intent...')
  const result = await fischerClient.send(
    jarvis.beamId,
    'forderung.escalate',
    {
      customer: 'Max Mustermann',
      project: 'PV-0001',
      invoice: 'INV-2026-001',
      amount: 3500,
      reason: 'Zahlungsverweigerung trotz Mahnung',
      urgency: 'high'
    }
  )

  console.log('\n  📬 Fischer received response:')
  console.log(`     Success: ${result.success}`)
  console.log(`     Action: ${result.payload?.action}`)
  console.log(`     Message: ${result.payload?.message}`)

  // 5. Use Case: Clara → Fischer (Customer callback about invoice)
  console.log('\n=== USE CASE: Clara → Fischer Callback ===\n')

  const claraClient = new BeamClient({
    identity: clara.export(),
    directoryUrl: DIRECTORY_URL
  })

  fischerClient.on('customer.callback', (_frame, respond) => {
    console.log('  📨 Fischer received callback request!')
    console.log(`     Customer: ${_frame.params?.customer}`)
    console.log(`     Phone: ${_frame.params?.phone}`)
    console.log(`     Topic: ${_frame.params?.topic}`)

    respond({
      success: true,
      payload: {
        ticket: 'FORD-2026-042',
        status: 'created',
        assignedTo: 'fischer',
        message: 'Ticket erstellt. Fischer kümmert sich innerhalb 24h.'
      }
    })
  })

  await claraClient.connect()

  console.log('  Clara sends callback intent...')
  const callbackResult = await claraClient.send(
    fischer.beamId,
    'customer.callback',
    {
      customer: 'Maria Beispiel',
      phone: '+49176XXXXXXXX',
      topic: 'Rechnung RE-2026-099 unklar',
      source: 'inbound-call'
    }
  )

  console.log('\n  📬 Clara received response:')
  console.log(`     Ticket: ${callbackResult.payload?.ticket}`)
  console.log(`     Status: ${callbackResult.payload?.status}`)
  console.log(`     Message: ${callbackResult.payload?.message}`)

  // Cleanup
  await fischerClient.disconnect()
  await jarvisClient.disconnect()
  await claraClient.disconnect()

  console.log('\n=== DOGFOOD COMPLETE ✅ ===')
  console.log('3 agents registered, 2 real use cases executed over Beam Protocol.')
  console.log('All communication via beam.directory identities + signed frames.')
}

main().catch(console.error)
