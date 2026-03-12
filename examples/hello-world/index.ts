import { allowIntent, createRegisteredClient, directoryUrl, shutdown } from '../shared.js'

async function main(): Promise<void> {
  const receiver = await createRegisteredClient({
    prefix: 'hello-receiver',
    displayName: 'Hello Receiver',
    capabilities: ['conversation.message'],
  })

  receiver.onTalk(async (message, from, respond) => {
    console.log(`[receiver] ${from} said: ${message}`)
    respond(`Hello back from ${receiver.beamId}`, { echoed: message })
  })

  await receiver.connect()

  const sender = await createRegisteredClient({
    prefix: 'hello-sender',
    displayName: 'Hello Sender',
    capabilities: [],
  })

  await allowIntent({
    targetBeamId: receiver.beamId,
    intentType: 'conversation.message',
    allowedFrom: sender.beamId,
  })

  const result = await sender.talk(receiver.beamId, 'Hello from Beam')

  console.log(`directory: ${directoryUrl}`)
  console.log(`sender:    ${sender.beamId}`)
  console.log(`receiver:  ${receiver.beamId}`)
  console.log(`reply:     ${result.message}`)
  console.log(`payload:   ${JSON.stringify(result.structured ?? {})}`)

  shutdown(receiver, sender)
}

main().catch((error) => {
  console.error('[hello-world] failed:', error)
  process.exit(1)
})
