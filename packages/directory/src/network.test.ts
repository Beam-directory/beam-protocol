import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { signPayload } from './crypto.js'
import { createDatabase, registerAgent } from './db.js'
import { createApp } from './server.js'
import type { BeamIdentityKind } from './types.js'

type TestIdentity = {
  beamId: string
  apiKey: string
  privateKey: KeyObject
  dhPublicKey: string
}

function createIdentity(
  db: ReturnType<typeof createDatabase>,
  input: {
    beamId: string
    displayName: string
    identityKind: BeamIdentityKind
    visibility?: 'public' | 'unlisted'
    org?: string | null
  },
): TestIdentity {
  const keys = generateKeyPairSync('ed25519')
  const encryptionKeys = generateKeyPairSync('x25519')
  const apiKey = createAgentApiKey(input.beamId)
  const isPerson = input.identityKind === 'person'
  registerAgent(db, {
    beamId: input.beamId,
    displayName: input.displayName,
    capabilities: ['identity.network'],
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    dhPublicKey: encryptionKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    apiKeyHash: hashApiKey(apiKey),
    identityKind: input.identityKind,
    personal: isPerson,
    org: input.org ?? (isPerson ? 'personal' : null),
    email: isPerson ? `${input.beamId.split('@')[0]}@example.com` : null,
    emailVerified: isPerson,
    verificationTier: isPerson ? 'basic' : 'business',
    visibility: input.visibility ?? 'unlisted',
  })

  return {
    beamId: input.beamId,
    apiKey,
    privateKey: keys.privateKey,
    dhPublicKey: encryptionKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

function authHeaders(identity: TestIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.apiKey}`,
    'content-type': 'application/json',
  }
}

function signedRequestBody(
  requester: TestIdentity,
  recipientBeamId: string,
  message: string,
  nonce = randomUUID(),
): Record<string, string> {
  const timestamp = new Date().toISOString()
  const payload = {
    type: 'network.connection.request',
    requesterBeamId: requester.beamId,
    recipientBeamId,
    message,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, requester.privateKey) }
}

function signedResponseBody(
  actor: TestIdentity,
  connectionId: string,
  decision: 'accepted' | 'declined' | 'blocked',
): Record<string, string> {
  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const payload = {
    type: 'network.connection.respond',
    connectionId,
    actorBeamId: actor.beamId,
    decision,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, actor.privateKey) }
}

function signedRemoveBody(actor: TestIdentity, connectionId: string): Record<string, string> {
  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const payload = {
    type: 'network.connection.remove',
    connectionId,
    actorBeamId: actor.beamId,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, actor.privateKey) }
}

function signedNetworkMutation(
  actor: TestIdentity,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const signed = { ...payload, timestamp, nonce }
  return { ...signed, signature: signPayload(signed, actor.privateKey) }
}

async function connectIdentities(
  app: ReturnType<typeof createApp>,
  requester: TestIdentity,
  recipient: TestIdentity,
): Promise<string> {
  const requested = await app.request('http://localhost/network/connections', {
    method: 'POST',
    headers: authHeaders(requester),
    body: JSON.stringify(signedRequestBody(requester, recipient.beamId, 'Trusted contact')),
  })
  assert.equal(requested.status, 201)
  const connectionId = (await requested.json() as { connection: { connectionId: string } }).connection.connectionId
  const accepted = await app.request(`http://localhost/network/connections/${connectionId}/respond`, {
    method: 'POST',
    headers: authHeaders(recipient),
    body: JSON.stringify(signedResponseBody(recipient, connectionId, 'accepted')),
  })
  assert.equal(accepted.status, 200)
  return connectionId
}

test('Beam network completes a private signed contact handshake without leaking private identity data', async () => {
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const ada = createIdentity(db, {
    beamId: 'ada@beam.directory',
    displayName: 'Ada Lovelace',
    identityKind: 'person',
  })
  const grace = createIdentity(db, {
    beamId: 'grace@beam.directory',
    displayName: 'Grace Hopper',
    identityKind: 'person',
  })

  try {
    const unauthorized = await app.request('http://localhost/network/me')
    assert.equal(unauthorized.status, 401)

    const hiddenFuzzy = await app.request('http://localhost/network/discover?q=grace', {
      headers: authHeaders(ada),
    })
    assert.equal(hiddenFuzzy.status, 200)
    assert.equal(((await hiddenFuzzy.json()) as { total: number }).total, 0)

    const exact = await app.request(`http://localhost/network/discover?q=${encodeURIComponent(grace.beamId)}`, {
      headers: authHeaders(ada),
    })
    assert.equal(exact.status, 200)
    const exactBody = await exact.json() as {
      results: Array<{ identity: Record<string, unknown>; connection: unknown }>
    }
    assert.equal(exactBody.results.length, 1)
    assert.equal(exactBody.results[0]?.identity['beamId'], grace.beamId)
    assert.equal(exactBody.results[0]?.identity['assurance'], 'email')
    assert.equal('email' in (exactBody.results[0]?.identity ?? {}), false)
    assert.equal('publicKey' in (exactBody.results[0]?.identity ?? {}), false)

    const requestBody = signedRequestBody(ada, grace.beamId, 'Let us connect.')
    const requested = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(requestBody),
    })
    assert.equal(requested.status, 201)
    const requestedBody = await requested.json() as {
      connection: { connectionId: string; status: string; direction: string; relationshipType: string }
    }
    assert.equal(requestedBody.connection.status, 'pending')
    assert.equal(requestedBody.connection.direction, 'outbound')
    assert.equal(requestedBody.connection.relationshipType, 'C2C')

    const replay = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(requestBody),
    })
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { errorCode: string }).errorCode, 'NONCE_REPLAY')

    const inbound = await app.request('http://localhost/network/connections', {
      headers: authHeaders(grace),
    })
    assert.equal(inbound.status, 200)
    const inboundBody = await inbound.json() as {
      connections: Array<{ direction: string; counterpart: { beamId: string } }>
    }
    assert.equal(inboundBody.connections[0]?.direction, 'inbound')
    assert.equal(inboundBody.connections[0]?.counterpart.beamId, ada.beamId)

    const foreignResponse = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify(signedResponseBody(ada, requestedBody.connection.connectionId, 'accepted')),
      },
    )
    assert.equal(foreignResponse.status, 404)

    const accepted = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(grace),
        body: JSON.stringify(signedResponseBody(grace, requestedBody.connection.connectionId, 'accepted')),
      },
    )
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json() as { connection: { status: string } }).connection.status, 'accepted')

    const contacts = await app.request('http://localhost/network/connections', {
      headers: authHeaders(ada),
    })
    const contactsBody = await contacts.json() as {
      connections: Array<{ status: string; counterpart: { beamId: string } }>
    }
    assert.equal(contactsBody.connections[0]?.status, 'accepted')
    assert.equal(contactsBody.connections[0]?.counterpart.beamId, grace.beamId)

    const removed = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}`,
      {
        method: 'DELETE',
        headers: authHeaders(grace),
        body: JSON.stringify(signedRemoveBody(grace, requestedBody.connection.connectionId)),
      },
    )
    assert.equal(removed.status, 200)
    assert.equal((await removed.json() as { connection: { status: string } }).connection.status, 'cancelled')
  } finally {
    db.close()
  }
})

test('Beam network classifies C2C, C2B, B2C, and B2B relationships from verified principals', async () => {
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const personOne = createIdentity(db, {
    beamId: 'person-one@beam.directory',
    displayName: 'Person One',
    identityKind: 'person',
  })
  const personTwo = createIdentity(db, {
    beamId: 'person-two@beam.directory',
    displayName: 'Person Two',
    identityKind: 'person',
  })
  const company = createIdentity(db, {
    beamId: 'company@northstar.beam.directory',
    displayName: 'Northstar',
    identityKind: 'organization',
    org: 'northstar',
  })
  const agent = createIdentity(db, {
    beamId: 'concierge@northstar.beam.directory',
    displayName: 'Northstar Concierge',
    identityKind: 'agent',
    org: 'northstar',
  })
  const service = createIdentity(db, {
    beamId: 'procurement@orbit.beam.directory',
    displayName: 'Orbit Procurement',
    identityKind: 'service',
    org: 'orbit',
  })

  async function requestType(
    requester: TestIdentity,
    recipient: TestIdentity,
    expected: 'C2C' | 'C2B' | 'B2C' | 'B2B',
  ): Promise<void> {
    const response = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(requester),
      body: JSON.stringify(signedRequestBody(requester, recipient.beamId, 'Verified hello')),
    })
    assert.equal(response.status, 201)
    const body = await response.json() as { connection: { relationshipType: string } }
    assert.equal(body.connection.relationshipType, expected)
  }

  try {
    await requestType(personOne, personTwo, 'C2C')
    await requestType(personOne, company, 'C2B')
    await requestType(agent, personTwo, 'B2C')
    await requestType(agent, service, 'B2B')
  } finally {
    db.close()
  }
})

test('Beam network synchronizes signed direct messages, groups, attachments, and devices across members', async () => {
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const ada = createIdentity(db, {
    beamId: 'ada-chat@beam.directory',
    displayName: 'Ada Chat',
    identityKind: 'person',
  })
  const grace = createIdentity(db, {
    beamId: 'grace-chat@beam.directory',
    displayName: 'Grace Chat',
    identityKind: 'person',
  })
  const stranger = createIdentity(db, {
    beamId: 'stranger-chat@beam.directory',
    displayName: 'Stranger Chat',
    identityKind: 'person',
  })

  try {
    const blockedDirect = await app.request('http://localhost/network/conversations/direct', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.conversation.direct',
        actorBeamId: ada.beamId,
        counterpartBeamId: grace.beamId,
      })),
    })
    assert.equal(blockedDirect.status, 403)

    const contactConnectionId = await connectIdentities(app, ada, grace)

    const direct = await app.request('http://localhost/network/conversations/direct', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.conversation.direct',
        actorBeamId: ada.beamId,
        counterpartBeamId: grace.beamId,
      })),
    })
    assert.equal(direct.status, 201)
    const directBody = await direct.json() as { conversation: { conversationId: string; kind: string } }
    assert.equal(directBody.conversation.kind, 'direct')

    const directAgain = await app.request('http://localhost/network/conversations/direct', {
      method: 'POST',
      headers: authHeaders(grace),
      body: JSON.stringify(signedNetworkMutation(grace, {
        type: 'network.conversation.direct',
        actorBeamId: grace.beamId,
        counterpartBeamId: ada.beamId,
      })),
    })
    assert.equal(directAgain.status, 200)
    assert.equal((await directAgain.json() as { conversation: { conversationId: string } }).conversation.conversationId, directBody.conversation.conversationId)

    const file = Buffer.from('signed beam attachment')
    const attachment = {
      name: 'proof.txt',
      mimeType: 'text/plain',
      byteSize: file.byteLength,
      sha256: createHash('sha256').update(file).digest('hex'),
    }
    const messageProof = signedNetworkMutation(ada, {
      type: 'network.message.send',
      conversationId: directBody.conversation.conversationId,
      senderBeamId: ada.beamId,
      body: 'Hello from Beam.',
      messageType: 'file',
      attachment,
      automationDepth: 0,
    })
    const message = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({ ...messageProof, attachment: { ...attachment, dataBase64: file.toString('base64') } }),
    })
    assert.equal(message.status, 201)
    const messageBody = await message.json() as { message: { attachment: { attachmentId: string } } }

    const graceMessages = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      headers: authHeaders(grace),
    })
    assert.equal(graceMessages.status, 200)
    const graceMessageBody = await graceMessages.json() as { messages: Array<{ body: string; attachment: { sha256: string } }> }
    assert.equal(graceMessageBody.messages[0]?.body, 'Hello from Beam.')
    assert.equal(graceMessageBody.messages[0]?.attachment.sha256, attachment.sha256)

    const encryptedEnvelope = {
      version: 1,
      algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
      ephemeralPublicKey: generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      salt: randomBytes(32).toString('base64'),
      nonce: randomBytes(12).toString('base64'),
      ciphertext: randomBytes(64).toString('base64'),
      recipients: [ada, grace]
        .sort((left, right) => left.beamId.localeCompare(right.beamId))
        .map((identity) => ({
          beamId: identity.beamId,
          nonce: randomBytes(12).toString('base64'),
          wrappedKey: randomBytes(48).toString('base64'),
        })),
    }
    const encryptedMessage = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.message.send',
        conversationId: directBody.conversation.conversationId,
        senderBeamId: ada.beamId,
        body: '',
        messageType: 'text',
        attachment: null,
        encrypted: encryptedEnvelope,
        automationDepth: 0,
      })),
    })
    assert.equal(encryptedMessage.status, 201)
    const encryptedMessageBody = await encryptedMessage.json() as {
      message: { body: string; attachment: null; encrypted: { ciphertext: string } }
    }
    assert.equal(encryptedMessageBody.message.body, '')
    assert.equal(encryptedMessageBody.message.attachment, null)
    assert.equal(encryptedMessageBody.message.encrypted.ciphertext, encryptedEnvelope.ciphertext)

    const originalE2eeRequirement = process.env['BEAM_NETWORK_REQUIRE_E2EE']
    process.env['BEAM_NETWORK_REQUIRE_E2EE'] = 'true'
    try {
      const rejectedPlaintext = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
        method: 'POST',
        headers: authHeaders(grace),
        body: JSON.stringify(signedNetworkMutation(grace, {
          type: 'network.message.send',
          conversationId: directBody.conversation.conversationId,
          senderBeamId: grace.beamId,
          body: 'Plaintext must fail closed.',
          messageType: 'text',
          attachment: null,
          automationDepth: 1,
        })),
      })
      assert.equal(rejectedPlaintext.status, 409)
      assert.equal((await rejectedPlaintext.json() as { errorCode: string }).errorCode, 'ENCRYPTION_REQUIRED')
    } finally {
      if (originalE2eeRequirement === undefined) delete process.env['BEAM_NETWORK_REQUIRE_E2EE']
      else process.env['BEAM_NETWORK_REQUIRE_E2EE'] = originalE2eeRequirement
    }

    const agentStyleReply = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(grace),
      body: JSON.stringify(signedNetworkMutation(grace, {
        type: 'network.message.send',
        conversationId: directBody.conversation.conversationId,
        senderBeamId: grace.beamId,
        body: 'Automated reply with loop protection.',
        messageType: 'text',
        attachment: null,
        automationDepth: 1,
      })),
    })
    assert.equal(agentStyleReply.status, 201)
    assert.equal((await agentStyleReply.json() as { message: { automationDepth: number } }).message.automationDepth, 1)

    const attachmentResponse = await app.request(`http://localhost/network/attachments/${messageBody.message.attachment.attachmentId}`, {
      headers: { authorization: `Bearer ${grace.apiKey}` },
    })
    assert.equal(attachmentResponse.status, 200)
    assert.equal(await attachmentResponse.text(), file.toString())

    const strangerRead = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      headers: authHeaders(stranger),
    })
    assert.equal(strangerRead.status, 404)

    const deviceId = 'device_ada_chat_0001'
    const device = await app.request('http://localhost/network/devices', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.device.register',
        actorBeamId: ada.beamId,
        deviceId,
        label: 'Ada Mac',
        platform: 'test',
      })),
    })
    assert.equal(device.status, 201)
    const devices = await app.request('http://localhost/network/devices', { headers: authHeaders(ada) })
    assert.equal((await devices.json() as { devices: unknown[] }).devices.length, 1)

    const group = await app.request('http://localhost/network/groups', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.group.create',
        actorBeamId: ada.beamId,
        title: 'Verified Crew',
        memberBeamIds: [grace.beamId],
      })),
    })
    assert.equal(group.status, 201)
    assert.equal((await group.json() as { conversation: { members: unknown[] } }).conversation.members.length, 2)

    const pushConfig = await app.request('http://localhost/network/notifications/config', { headers: authHeaders(ada) })
    assert.equal(pushConfig.status, 200)
    assert.equal((await pushConfig.json() as { enabled: boolean }).enabled, false)

    const removed = await app.request(`http://localhost/network/connections/${contactConnectionId}`, {
      method: 'DELETE',
      headers: authHeaders(ada),
      body: JSON.stringify(signedRemoveBody(ada, contactConnectionId)),
    })
    assert.equal(removed.status, 200)
    const disconnectedMessage = await app.request(`http://localhost/network/conversations/${directBody.conversation.conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(signedNetworkMutation(ada, {
        type: 'network.message.send',
        conversationId: directBody.conversation.conversationId,
        senderBeamId: ada.beamId,
        body: 'This must stay blocked.',
        messageType: 'text',
        attachment: null,
        automationDepth: 0,
      })),
    })
    assert.equal(disconnectedMessage.status, 403)
  } finally {
    db.close()
  }
})
