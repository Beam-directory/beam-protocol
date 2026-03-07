/**
 * Example: Two agents having a natural language conversation via Beam Protocol.
 *
 * Run:
 *   1. Start the directory: cd packages/directory && npm start
 *   2. Run this: npx tsx examples/natural-language-chat.ts
 */

import { BeamIdentity, BeamClient } from '@beam-protocol/sdk'

async function main() {
  const directoryUrl = 'https://api.beam.directory'

  // ── Agent A: Jarvis (asks questions) ─────────────────────────────────────

  const jarvis = new BeamClient({
    identity: BeamIdentity.generate({ agentName: 'jarvis', orgName: 'demo' }).export(),
    directoryUrl,
  })

  await jarvis.connect()
  await jarvis.register('Jarvis', ['orchestration', 'conversation'])
  console.log('🤖 Jarvis connected')

  // ── Agent B: Clara (has sales knowledge) ─────────────────────────────────

  const clara = new BeamClient({
    identity: BeamIdentity.generate({ agentName: 'clara', orgName: 'demo' }).export(),
    directoryUrl,
  })

  await clara.connect()
  await clara.register('Clara', ['sales', 'crm', 'conversation'])
  console.log('👩‍💼 Clara connected')

  // Clara listens for natural language messages
  clara.onTalk(async (message, from, respond) => {
    console.log(`\n📨 Clara received from ${from}:`)
    console.log(`   "${message}"`)

    // In production, this would go to Clara's LLM with tool access.
    // Here we simulate a response:
    if (message.toLowerCase().includes('schnorrenberg')) {
      respond(
        'Chris Schnorrenberg ist Area Sales Manager PV. ' +
        '50 Deals im HubSpot, Gesamtvolumen €1.628.555. ' +
        'Letzte Aktivität vor 3 Tagen — Deal mit Müller GmbH abgeschlossen.',
        {
          name: 'Christopher Schnorrenberg',
          role: 'Area Sales Manager PV',
          deals: 50,
          volume: 1628555,
          lastActive: '2026-03-04',
        }
      )
    } else {
      respond('Ich kann dir gerne helfen. Was genau möchtest du wissen?')
    }
  })

  // ── Conversation ─────────────────────────────────────────────────────────

  console.log('\n─── Conversation Start ───\n')

  // Jarvis asks Clara in natural language
  const reply = await jarvis.talk(
    'clara@demo.beam.directory',
    'Hey Clara, was weißt du über Chris Schnorrenberg? Deals, Volumen, letzte Aktivität bitte.'
  )

  console.log(`\n📬 Jarvis got reply:`)
  console.log(`   Message: "${reply.message}"`)
  if (reply.structured) {
    console.log(`   Structured: ${JSON.stringify(reply.structured, null, 2)}`)
  }

  console.log('\n─── Conversation End ───')
  console.log(`\n✅ Natural language exchange completed via Beam Protocol`)
  console.log(`   Intent: conversation.message`)
  console.log(`   Signed: Ed25519`)
  console.log(`   No schema required.`)

  // Cleanup
  jarvis.disconnect()
  clara.disconnect()
}

main().catch(console.error)
