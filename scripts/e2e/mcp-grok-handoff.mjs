import assert from 'node:assert/strict'
import { once } from 'node:events'
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
import { createAcl } from '../../packages/directory/dist/acl.js'
import { createDatabase, markAgentDomainVerified } from '../../packages/directory/dist/db.js'
import { startServer } from '../../packages/directory/dist/server.js'
import { createBeamToolHandlers } from '../../packages/mcp-server/dist/tools.js'

const db = createDatabase(':memory:')
const server = startServer(db, 0)
let receiver

try {
  if (!server.listening) {
    await once(server, 'listening')
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Directory did not expose a TCP address')
  }
  const directoryUrl = `http://127.0.0.1:${address.port}`

  const grokIdentity = BeamIdentity.generate({ agentName: 'grok-pilot', orgName: 'acme' })
  const partnerIdentity = BeamIdentity.generate({ agentName: 'support-pilot', orgName: 'partner' })
  const grok = new BeamClient({ identity: grokIdentity.export(), directoryUrl })
  receiver = new BeamClient({ identity: partnerIdentity.export(), directoryUrl })

  await grok.register('Grok pilot', ['conversation.message'])
  await receiver.register('Partner support pilot', ['conversation.message'])
  markAgentDomainVerified(db, grok.beamId)
  markAgentDomainVerified(db, receiver.beamId)
  createAcl(db, {
    targetBeamId: receiver.beamId,
    intentType: 'conversation.message',
    allowedFrom: grok.beamId,
  })

  receiver.onTalk(async (message, from, respond) => {
    respond(`Accepted by partner: ${message}`, { acceptedFrom: from, workflow: 'support-handoff' })
  })
  await receiver.connect()

  const handlers = createBeamToolHandlers({
    gateway: {
      getStats: () => grok.getStats(),
      lookup: (beamId) => grok.directory.lookup(beamId),
      send: (to, intent, payload, timeoutMs) => grok.send(to, intent, payload, timeoutMs),
    },
    ownBeamId: grok.beamId,
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumTrustScore: 0.5,
  })

  const preview = await handlers.prepareHandoff({
    to: receiver.beamId,
    message: 'Please take over ticket SUP-42.',
    context: { ticket: 'SUP-42' },
  })
  assert.equal(preview.ready, true)
  assert.equal(preview.requiresHumanConfirmation, true)

  const delivered = await handlers.send({
    to: receiver.beamId,
    message: 'Please take over ticket SUP-42.',
    context: { ticket: 'SUP-42' },
    confirmed: true,
    timeoutMs: 5_000,
  })
  const result = delivered.result
  assert.equal(delivered.delivered, true)
  assert.equal(result.success, true)
  assert.equal(result.signed, true)
  assert.equal(result.payload.message, 'Accepted by partner: Please take over ticket SUP-42.')

  process.stdout.write(`${JSON.stringify({
    ok: true,
    path: 'grok-mcp-beam-agent',
    from: grok.beamId,
    to: receiver.beamId,
    targetVerified: preview.target.verified,
    resultSigned: result.signed,
    nonce: result.nonce,
  })}\n`)
} finally {
  receiver?.disconnect()
  await new Promise((resolve) => server.close(resolve))
  db.close()
}
