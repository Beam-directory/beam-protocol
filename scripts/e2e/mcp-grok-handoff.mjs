import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
import { createAcl } from '../../packages/directory/dist/acl.js'
import { createDatabase, createOrg, markAgentDomainVerified, markOrgVerified } from '../../packages/directory/dist/db.js'
import { startServer } from '../../packages/directory/dist/server.js'
import { BeamNetworkClient } from '../../packages/mcp-server/dist/network-client.js'
import { createBeamToolHandlers } from '../../packages/mcp-server/dist/tools.js'

const db = createDatabase(':memory:')
const server = startServer(db, 0)
let receiver

try {
  const acmeOrgApiKey = 'beam_org_acme_mcp_test_only'
  const partnerOrgApiKey = 'beam_org_partner_mcp_test_only'
  createOrg(db, {
    name: 'acme',
    displayName: 'Acme',
    domain: 'acme.example',
    apiKeyHash: createHash('sha256').update(acmeOrgApiKey).digest('hex'),
    verificationToken: 'acme-mcp-test-only',
  })
  createOrg(db, {
    name: 'partner',
    displayName: 'Partner',
    domain: 'partner.example',
    apiKeyHash: createHash('sha256').update(partnerOrgApiKey).digest('hex'),
    verificationToken: 'partner-mcp-test-only',
  })
  markOrgVerified(db, 'acme')
  markOrgVerified(db, 'partner')

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
  const grok = new BeamClient({ identity: grokIdentity.export(), directoryUrl, apiKey: acmeOrgApiKey })
  receiver = new BeamClient({ identity: partnerIdentity.export(), directoryUrl, apiKey: partnerOrgApiKey })

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

  assert.ok(grok.apiKey)
  assert.ok(receiver.apiKey)
  const grokIdentityData = grokIdentity.export()
  const partnerIdentityData = partnerIdentity.export()
  const grokNetwork = new BeamNetworkClient({
    beamId: grok.beamId,
    publicKeyBase64: grokIdentityData.publicKeyBase64,
    privateKeyBase64: grokIdentityData.privateKeyBase64,
    apiKey: grok.apiKey,
    directoryUrl,
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumVerificationTier: 'verified',
    minimumTrustScore: 0.5,
  })
  const partnerNetwork = new BeamNetworkClient({
    beamId: receiver.beamId,
    publicKeyBase64: partnerIdentityData.publicKeyBase64,
    privateKeyBase64: partnerIdentityData.privateKeyBase64,
    apiKey: receiver.apiKey,
    directoryUrl,
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumVerificationTier: 'verified',
    minimumTrustScore: 0.5,
  })

  await grokNetwork.requestConnection(receiver.beamId, 'Connect Grok and partner support')
  const pending = await partnerNetwork.connections(['pending'])
  const pendingConnection = pending.connections?.[0]
  assert.equal(pendingConnection?.requesterBeamId, grok.beamId)
  await partnerNetwork.respondConnection(pendingConnection.connectionId, 'accepted')
  const opened = await grokNetwork.openDirect(receiver.beamId)
  const conversationId = opened.conversation?.conversationId
  assert.equal(typeof conversationId, 'string')
  const networkDelivery = await grokNetwork.sendMessage(conversationId, 'Hello through Beam Network MCP')
  const partnerInbox = await partnerNetwork.conversations()
  assert.equal(partnerInbox.conversations?.[0]?.conversationId, conversationId)
  const partnerMessages = await partnerNetwork.messages(conversationId, 10)
  assert.equal(partnerMessages.messages?.[0]?.body, 'Hello through Beam Network MCP')

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
    networkConversationId: conversationId,
    networkMessageId: networkDelivery.message?.messageId,
    nonce: result.nonce,
  })}\n`)
} finally {
  receiver?.disconnect()
  await new Promise((resolve) => server.close(resolve))
  db.close()
}
