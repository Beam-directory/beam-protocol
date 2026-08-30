import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { Hono } from 'hono'
import webPush from 'web-push'
import { getAgent, getBeamConnectionBetween, logAuditEvent } from '../db.js'
import { broadcastNetworkEvent, isAgentConnected } from '../websocket.js'
import type { AgentRow } from '../types.js'
import {
  authenticateNetworkIdentity,
  isNetworkAssured,
  readNetworkObjectBody,
  safeNetworkProfile,
  verifyNetworkSignedMutation,
} from './network.js'

const MAX_MESSAGE_LENGTH = 4_000
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024
const MAX_ENCRYPTED_PLAINTEXT_BYTES = 9 * 1024 * 1024
const ENCRYPTION_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM'
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
])

type ConversationRow = {
  conversation_id: string
  kind: 'direct' | 'group'
  pair_key: string | null
  title: string | null
  created_by_beam_id: string
  created_at: string
  updated_at: string
}

type ConversationMemberRow = {
  conversation_id: string
  beam_id: string
  role: 'owner' | 'member'
  joined_at: string
  last_read_at: string | null
}

type MessageRow = {
  message_id: string
  conversation_id: string
  sender_beam_id: string
  body: string
  message_type: 'text' | 'file' | 'audio'
  attachment_id: string | null
  automation_depth: number
  sender_signature: string
  created_at: string
  file_name: string | null
  mime_type: string | null
  byte_size: number | null
  sha256: string | null
  encrypted_payload: string | null
}

type PushSubscriptionRow = {
  subscription_id: string
  beam_id: string
  device_id: string
  endpoint: string
  p256dh: string
  auth_secret: string
}

function pairKey(firstBeamId: string, secondBeamId: string): string {
  return [firstBeamId, secondBeamId].sort().join('::')
}

function getConversationForMember(
  db: Database,
  conversationId: string,
  beamId: string,
): ConversationRow | null {
  return db.prepare(`
    SELECT c.*
    FROM beam_conversations c
    JOIN beam_conversation_members m ON m.conversation_id = c.conversation_id
    WHERE c.conversation_id = ? AND m.beam_id = ?
  `).get(conversationId, beamId) as ConversationRow | undefined ?? null
}

function listConversationMembers(db: Database, conversationId: string): ConversationMemberRow[] {
  return db.prepare(`
    SELECT conversation_id, beam_id, role, joined_at, last_read_at
    FROM beam_conversation_members
    WHERE conversation_id = ?
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at ASC
  `).all(conversationId) as ConversationMemberRow[]
}

function messageSelect(): string {
  return `
    SELECT
      m.*,
      a.file_name,
      a.mime_type,
      a.byte_size,
      a.sha256
    FROM beam_messages m
    LEFT JOIN beam_attachments a ON a.attachment_id = m.attachment_id
  `
}

function serializeMessage(row: MessageRow): object {
  let encrypted: Record<string, unknown> | null = null
  if (row.encrypted_payload) {
    try { encrypted = JSON.parse(row.encrypted_payload) as Record<string, unknown> } catch { encrypted = null }
  }
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    senderBeamId: row.sender_beam_id,
    body: row.body,
    type: row.message_type,
    automationDepth: row.automation_depth,
    encrypted,
    attachment: row.attachment_id ? {
      attachmentId: row.attachment_id,
      name: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      url: `/network/attachments/${encodeURIComponent(row.attachment_id)}`,
    } : null,
    createdAt: row.created_at,
  }
}

function decodeBase64(value: unknown, minimumBytes: number, maximumBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length < 4 || value.length > Math.ceil(maximumBytes / 3) * 4 + 8 || !BASE64_RE.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.byteLength >= minimumBytes && decoded.byteLength <= maximumBytes ? decoded : null
  } catch {
    return null
  }
}

function normalizeEncryptedPayload(raw: unknown, memberBeamIds: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const envelope = raw as Record<string, unknown>
  if (envelope['version'] !== 1 || envelope['algorithm'] !== ENCRYPTION_ALGORITHM) return null
  if (!decodeBase64(envelope['ephemeralPublicKey'], 40, 128)) return null
  if (!decodeBase64(envelope['salt'], 32, 32)) return null
  if (!decodeBase64(envelope['nonce'], 12, 12)) return null
  if (!decodeBase64(envelope['ciphertext'], 17, MAX_ENCRYPTED_PLAINTEXT_BYTES + 16)) return null
  if (!Array.isArray(envelope['recipients']) || envelope['recipients'].length !== memberBeamIds.length) return null

  const expected = new Set(memberBeamIds)
  const seen = new Set<string>()
  const recipients: Array<{ beamId: string; nonce: string; wrappedKey: string }> = []
  for (const value of envelope['recipients']) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    const beamId = typeof item['beamId'] === 'string' ? item['beamId'].trim().toLowerCase() : ''
    if (!expected.has(beamId) || seen.has(beamId)) return null
    if (!decodeBase64(item['nonce'], 12, 12) || !decodeBase64(item['wrappedKey'], 48, 48)) return null
    seen.add(beamId)
    recipients.push({ beamId, nonce: item['nonce'] as string, wrappedKey: item['wrappedKey'] as string })
  }
  if (seen.size !== expected.size) return null

  recipients.sort((left, right) => left.beamId.localeCompare(right.beamId))
  return {
    version: 1,
    algorithm: ENCRYPTION_ALGORITHM,
    ephemeralPublicKey: envelope['ephemeralPublicKey'],
    salt: envelope['salt'],
    nonce: envelope['nonce'],
    ciphertext: envelope['ciphertext'],
    recipients,
  }
}

function serializeConversation(db: Database, row: ConversationRow, viewerBeamId: string): object {
  const members = listConversationMembers(db, row.conversation_id)
  const memberProfiles = members.map((member) => {
    const agent = getAgent(db, member.beam_id)
    return {
      beamId: member.beam_id,
      role: member.role,
      online: isAgentConnected(member.beam_id),
      profile: agent ? safeNetworkProfile(db, agent) : null,
    }
  })
  const counterpart = row.kind === 'direct'
    ? memberProfiles.find((member) => member.beamId !== viewerBeamId) ?? null
    : null
  const lastMessage = db.prepare(`
    ${messageSelect()}
    WHERE m.conversation_id = ?
    ORDER BY m.created_at DESC, m.message_id DESC
    LIMIT 1
  `).get(row.conversation_id) as MessageRow | undefined
  const viewer = members.find((member) => member.beam_id === viewerBeamId)
  const unread = db.prepare(`
    SELECT COUNT(*) AS count
    FROM beam_messages
    WHERE conversation_id = ?
      AND sender_beam_id <> ?
      AND created_at > COALESCE(?, '')
  `).get(row.conversation_id, viewerBeamId, viewer?.last_read_at ?? null) as { count: number }

  return {
    conversationId: row.conversation_id,
    kind: row.kind,
    title: row.kind === 'group'
      ? row.title
      : counterpart?.profile && typeof counterpart.profile === 'object' && 'displayName' in counterpart.profile
        ? counterpart.profile.displayName
        : counterpart?.beamId ?? 'Direct conversation',
    createdByBeamId: row.created_by_beam_id,
    members: memberProfiles,
    counterpart,
    online: row.kind === 'direct' ? Boolean(counterpart?.online) : memberProfiles.some((member) => member.beamId !== viewerBeamId && member.online),
    unread: unread.count,
    lastMessage: lastMessage ? serializeMessage(lastMessage) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isAcceptedContact(db: Database, firstBeamId: string, secondBeamId: string): boolean {
  return getBeamConnectionBetween(db, firstBeamId, secondBeamId)?.status === 'accepted'
}

function normalizeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length >= 1 && cleaned.length <= 120 ? cleaned : null
}

function normalizeAttachment(raw: unknown): {
  metadata: { name: string; mimeType: string; byteSize: number; sha256: string }
  content: Buffer
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const name = normalizeFileName(input['name'])
  const mimeType = typeof input['mimeType'] === 'string' ? input['mimeType'].toLowerCase().trim() : ''
  const byteSize = typeof input['byteSize'] === 'number' ? input['byteSize'] : -1
  const sha256 = typeof input['sha256'] === 'string' ? input['sha256'].toLowerCase() : ''
  const dataBase64 = typeof input['dataBase64'] === 'string' ? input['dataBase64'] : ''
  if (
    !name
    || !ALLOWED_ATTACHMENT_TYPES.has(mimeType)
    || !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || byteSize > MAX_ATTACHMENT_BYTES
    || !SHA256_RE.test(sha256)
    || dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16
  ) {
    return null
  }
  let content: Buffer
  try {
    content = Buffer.from(dataBase64, 'base64')
  } catch {
    return null
  }
  if (content.byteLength !== byteSize || createHash('sha256').update(content).digest('hex') !== sha256) {
    return null
  }
  return { metadata: { name, mimeType, byteSize, sha256 }, content }
}

let pushConfiguredFor = ''

function configurePush(): { enabled: boolean; publicKey: string | null } {
  const publicKey = process.env['BEAM_VAPID_PUBLIC_KEY']?.trim() ?? ''
  const privateKey = process.env['BEAM_VAPID_PRIVATE_KEY']?.trim() ?? ''
  const subject = process.env['BEAM_VAPID_SUBJECT']?.trim() || 'mailto:security@beam.directory'
  if (!publicKey || !privateKey) return { enabled: false, publicKey: null }
  const fingerprint = `${subject}:${publicKey}:${privateKey}`
  if (pushConfiguredFor !== fingerprint) {
    webPush.setVapidDetails(subject, publicKey, privateKey)
    pushConfiguredFor = fingerprint
  }
  return { enabled: true, publicKey }
}

async function notifyOfflineMembers(
  db: Database,
  conversationId: string,
  senderBeamId: string,
  message: MessageRow,
): Promise<void> {
  if (!configurePush().enabled) return
  const subscriptions = db.prepare(`
    SELECT s.*
    FROM beam_push_subscriptions s
    JOIN beam_conversation_members m ON m.beam_id = s.beam_id
    WHERE m.conversation_id = ? AND s.beam_id <> ?
  `).all(conversationId, senderBeamId) as PushSubscriptionRow[]
  const sender = getAgent(db, senderBeamId)
  const payload = JSON.stringify({
    type: 'network.message',
    conversationId,
    title: sender?.display_name || senderBeamId,
    body: message.encrypted_payload
      ? 'New end-to-end encrypted message'
      : message.body || (message.message_type === 'audio' ? 'Audio message' : 'Shared a file'),
    tag: `beam-conversation-${conversationId}`,
  })

  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret },
      }, payload, { TTL: 60 * 60 })
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 0
      if (statusCode === 404 || statusCode === 410) {
        db.prepare('DELETE FROM beam_push_subscriptions WHERE subscription_id = ?').run(subscription.subscription_id)
      }
    }
  }))
}

export function networkMessagingRouter(db: Database): Hono {
  const router = new Hono()

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    await next()
  })

  router.get('/conversations', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const rows = db.prepare(`
      SELECT c.*
      FROM beam_conversations c
      JOIN beam_conversation_members m ON m.conversation_id = c.conversation_id
      WHERE m.beam_id = ?
      ORDER BY c.updated_at DESC
    `).all(auth.agent.beam_id) as ConversationRow[]
    return c.json({
      conversations: rows.map((row) => serializeConversation(db, row, auth.agent.beam_id)),
      total: rows.length,
    })
  })

  router.post('/conversations/direct', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const counterpartBeamId = typeof raw['counterpartBeamId'] === 'string' ? raw['counterpartBeamId'].trim().toLowerCase() : ''
    const counterpart = getAgent(db, counterpartBeamId)
    if (!counterpart || !isNetworkAssured(db, counterpart) || !isAcceptedContact(db, auth.agent.beam_id, counterpartBeamId)) {
      return c.json({ error: 'Direct conversations require an accepted connection', errorCode: 'CONNECTION_REQUIRED' }, 403)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.conversation.direct',
      actorBeamId: auth.agent.beam_id,
      counterpartBeamId,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)

    const pair = pairKey(auth.agent.beam_id, counterpartBeamId)
    let row = db.prepare('SELECT * FROM beam_conversations WHERE pair_key = ?').get(pair) as ConversationRow | undefined
    let created = false
    if (!row) {
      const now = new Date().toISOString()
      const conversationId = randomUUID()
      db.transaction(() => {
        db.prepare(`
          INSERT INTO beam_conversations (
            conversation_id, kind, pair_key, title, created_by_beam_id, created_at, updated_at
          ) VALUES (?, 'direct', ?, NULL, ?, ?, ?)
        `).run(conversationId, pair, auth.agent.beam_id, now, now)
        const insertMember = db.prepare(`
          INSERT INTO beam_conversation_members (conversation_id, beam_id, role, joined_at, last_read_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        insertMember.run(conversationId, auth.agent.beam_id, 'owner', now, now)
        insertMember.run(conversationId, counterpartBeamId, 'member', now, now)
      })()
      row = db.prepare('SELECT * FROM beam_conversations WHERE conversation_id = ?').get(conversationId) as ConversationRow
      created = true
      broadcastNetworkEvent([auth.agent.beam_id, counterpartBeamId], {
        type: 'network.conversation.created',
        conversationId,
      })
    }
    return c.json({ conversation: serializeConversation(db, row, auth.agent.beam_id) }, created ? 201 : 200)
  })

  router.post('/groups', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const title = typeof raw['title'] === 'string' ? raw['title'].replace(/\s+/g, ' ').trim() : ''
    const requestedMembers = Array.isArray(raw['memberBeamIds'])
      ? Array.from(new Set(raw['memberBeamIds'].filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase())))
      : []
    if (title.length < 2 || title.length > 80 || requestedMembers.length < 1 || requestedMembers.length > 49) {
      return c.json({ error: 'Groups need a 2–80 character name and 1–49 contacts', errorCode: 'INVALID_GROUP' }, 400)
    }
    if (requestedMembers.some((beamId) => beamId === auth.agent.beam_id || !isAcceptedContact(db, auth.agent.beam_id, beamId))) {
      return c.json({ error: 'Every group member must be an accepted connection', errorCode: 'CONNECTION_REQUIRED' }, 403)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.group.create',
      actorBeamId: auth.agent.beam_id,
      title,
      memberBeamIds: requestedMembers,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)

    const conversationId = randomUUID()
    const now = new Date().toISOString()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO beam_conversations (
          conversation_id, kind, pair_key, title, created_by_beam_id, created_at, updated_at
        ) VALUES (?, 'group', NULL, ?, ?, ?, ?)
      `).run(conversationId, title, auth.agent.beam_id, now, now)
      const insertMember = db.prepare(`
        INSERT INTO beam_conversation_members (conversation_id, beam_id, role, joined_at, last_read_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      insertMember.run(conversationId, auth.agent.beam_id, 'owner', now, now)
      for (const beamId of requestedMembers) insertMember.run(conversationId, beamId, 'member', now, now)
    })()
    const row = db.prepare('SELECT * FROM beam_conversations WHERE conversation_id = ?').get(conversationId) as ConversationRow
    broadcastNetworkEvent([auth.agent.beam_id, ...requestedMembers], { type: 'network.group.created', conversationId })
    logAuditEvent(db, {
      action: 'network.group.created',
      actor: auth.agent.beam_id,
      target: conversationId,
      details: { title, members: requestedMembers },
    })
    return c.json({ conversation: serializeConversation(db, row, auth.agent.beam_id) }, 201)
  })

  router.post('/groups/:conversationId/members', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const conversationId = c.req.param('conversationId')
    const conversation = getConversationForMember(db, conversationId, auth.agent.beam_id)
    const membership = conversation && db.prepare(`
      SELECT role FROM beam_conversation_members WHERE conversation_id = ? AND beam_id = ?
    `).get(conversationId, auth.agent.beam_id) as { role: string } | undefined
    if (!conversation || conversation.kind !== 'group' || membership?.role !== 'owner') {
      return c.json({ error: 'Only the group owner can add members', errorCode: 'FORBIDDEN' }, 403)
    }
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const memberBeamId = typeof raw['memberBeamId'] === 'string' ? raw['memberBeamId'].trim().toLowerCase() : ''
    if (!isAcceptedContact(db, auth.agent.beam_id, memberBeamId)) {
      return c.json({ error: 'New members must be accepted connections', errorCode: 'CONNECTION_REQUIRED' }, 403)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.group.member.add',
      conversationId,
      actorBeamId: auth.agent.beam_id,
      memberBeamId,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT OR IGNORE INTO beam_conversation_members (conversation_id, beam_id, role, joined_at, last_read_at)
      VALUES (?, ?, 'member', ?, ?)
    `).run(conversationId, memberBeamId, now, now)
    db.prepare('UPDATE beam_conversations SET updated_at = ? WHERE conversation_id = ?').run(now, conversationId)
    broadcastNetworkEvent([...listConversationMembers(db, conversationId).map((member) => member.beam_id)], {
      type: 'network.group.updated',
      conversationId,
    })
    return c.json({ conversation: serializeConversation(db, conversation, auth.agent.beam_id) })
  })

  router.get('/conversations/:conversationId/messages', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const conversationId = c.req.param('conversationId')
    if (!getConversationForMember(db, conversationId, auth.agent.beam_id)) {
      return c.json({ error: 'Conversation not found', errorCode: 'CONVERSATION_NOT_FOUND' }, 404)
    }
    const rawLimit = Number(c.req.query('limit') ?? 80)
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 80
    const before = c.req.query('before')?.trim() ?? ''
    const rows = db.prepare(`
      ${messageSelect()}
      WHERE m.conversation_id = ?
        AND (? = '' OR m.created_at < ?)
      ORDER BY m.created_at DESC, m.message_id DESC
      LIMIT ?
    `).all(conversationId, before, before, limit) as MessageRow[]
    return c.json({ messages: rows.reverse().map(serializeMessage), total: rows.length })
  })

  router.post('/conversations/:conversationId/messages', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const conversationId = c.req.param('conversationId')
    const conversation = getConversationForMember(db, conversationId, auth.agent.beam_id)
    if (!conversation) return c.json({ error: 'Conversation not found', errorCode: 'CONVERSATION_NOT_FOUND' }, 404)
    if (conversation.kind === 'direct') {
      const counterpart = listConversationMembers(db, conversationId).find((member) => member.beam_id !== auth.agent.beam_id)
      if (!counterpart || !isAcceptedContact(db, auth.agent.beam_id, counterpart.beam_id)) {
        return c.json({ error: 'This direct connection is no longer active', errorCode: 'CONNECTION_REQUIRED' }, 403)
      }
    }
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const body = typeof raw['body'] === 'string' ? raw['body'].trim() : ''
    const requestedType = raw['messageType']
    const messageType = requestedType === 'audio' || requestedType === 'file' ? requestedType : 'text'
    const automationDepth = raw['automationDepth'] === 1 ? 1 : 0
    const memberBeamIds = listConversationMembers(db, conversationId).map((member) => member.beam_id)
    const encrypted = raw['encrypted'] == null ? null : normalizeEncryptedPayload(raw['encrypted'], memberBeamIds)
    const attachment = encrypted ? null : raw['attachment'] == null ? null : normalizeAttachment(raw['attachment'])
    if (raw['encrypted'] != null && !encrypted) {
      return c.json({ error: 'Invalid end-to-end encrypted message envelope', errorCode: 'INVALID_ENCRYPTED_MESSAGE' }, 400)
    }
    if (process.env['BEAM_NETWORK_REQUIRE_E2EE'] === 'true' && !encrypted) {
      return c.json({ error: 'This Beam network requires end-to-end encrypted messages', errorCode: 'ENCRYPTION_REQUIRED' }, 409)
    }
    if (!encrypted && (body.length > MAX_MESSAGE_LENGTH || (!body && !attachment) || ((messageType === 'audio' || messageType === 'file') && !attachment))) {
      return c.json({ error: 'Messages need text or a valid attachment up to 6 MB', errorCode: 'INVALID_MESSAGE' }, 400)
    }
    if (attachment && messageType === 'audio' && !attachment.metadata.mimeType.startsWith('audio/')) {
      return c.json({ error: 'Audio messages require an audio file', errorCode: 'INVALID_ATTACHMENT' }, 400)
    }
    const attachmentProof = attachment ? attachment.metadata : null
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.message.send',
      conversationId,
      senderBeamId: auth.agent.beam_id,
      body: encrypted ? '' : body,
      messageType: encrypted ? messageType : attachment ? messageType : 'text',
      attachment: attachmentProof,
      ...(encrypted ? { encrypted } : {}),
      ...(raw['automationDepth'] === undefined ? {} : { automationDepth }),
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)

    const now = new Date().toISOString()
    const messageId = randomUUID()
    const attachmentId = attachment ? randomUUID() : null
    db.transaction(() => {
      if (attachment && attachmentId) {
        db.prepare(`
          INSERT INTO beam_attachments (
            attachment_id, conversation_id, owner_beam_id, file_name, mime_type, byte_size, sha256, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attachmentId,
          conversationId,
          auth.agent.beam_id,
          attachment.metadata.name,
          attachment.metadata.mimeType,
          attachment.metadata.byteSize,
          attachment.metadata.sha256,
          attachment.content,
          now,
        )
      }
      db.prepare(`
        INSERT INTO beam_messages (
          message_id, conversation_id, sender_beam_id, body, message_type, attachment_id, encrypted_payload, automation_depth, sender_signature, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        conversationId,
        auth.agent.beam_id,
        encrypted ? '' : body,
        encrypted ? messageType : attachment ? messageType : 'text',
        attachmentId,
        encrypted ? JSON.stringify(encrypted) : null,
        automationDepth,
        proof.signature,
        now,
      )
      db.prepare('UPDATE beam_conversations SET updated_at = ? WHERE conversation_id = ?').run(now, conversationId)
      db.prepare(`
        UPDATE beam_conversation_members SET last_read_at = ? WHERE conversation_id = ? AND beam_id = ?
      `).run(now, conversationId, auth.agent.beam_id)
    })()
    const row = db.prepare(`${messageSelect()} WHERE m.message_id = ?`).get(messageId) as MessageRow
    const members = memberBeamIds
    const serialized = serializeMessage(row)
    broadcastNetworkEvent(members, { type: 'network.message.created', conversationId, message: serialized })
    void notifyOfflineMembers(db, conversationId, auth.agent.beam_id, row)
    return c.json({ message: serialized }, 201)
  })

  router.post('/conversations/:conversationId/read', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const conversationId = c.req.param('conversationId')
    if (!getConversationForMember(db, conversationId, auth.agent.beam_id)) {
      return c.json({ error: 'Conversation not found', errorCode: 'CONVERSATION_NOT_FOUND' }, 404)
    }
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.conversation.read',
      conversationId,
      actorBeamId: auth.agent.beam_id,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    const readAt = new Date().toISOString()
    db.prepare(`
      UPDATE beam_conversation_members SET last_read_at = ? WHERE conversation_id = ? AND beam_id = ?
    `).run(readAt, conversationId, auth.agent.beam_id)
    return c.json({ readAt })
  })

  router.get('/attachments/:attachmentId', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const row = db.prepare(`
      SELECT a.*
      FROM beam_attachments a
      JOIN beam_conversation_members m ON m.conversation_id = a.conversation_id
      WHERE a.attachment_id = ? AND m.beam_id = ?
    `).get(c.req.param('attachmentId'), auth.agent.beam_id) as {
      file_name: string
      mime_type: string
      content: Buffer
      sha256: string
    } | undefined
    if (!row) return c.json({ error: 'Attachment not found', errorCode: 'ATTACHMENT_NOT_FOUND' }, 404)
    return new Response(new Uint8Array(row.content), {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        'content-type': row.mime_type,
        'x-content-type-options': 'nosniff',
        'x-beam-content-sha256': row.sha256,
      },
    })
  })

  router.get('/devices', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const devices = db.prepare(`
      SELECT device_id, label, platform, created_at, last_seen_at
      FROM beam_devices WHERE beam_id = ? ORDER BY last_seen_at DESC
    `).all(auth.agent.beam_id) as Array<Record<string, unknown>>
    return c.json({ devices: devices.map((device) => ({
      deviceId: device['device_id'],
      label: device['label'],
      platform: device['platform'],
      createdAt: device['created_at'],
      lastSeenAt: device['last_seen_at'],
    })) })
  })

  router.post('/devices', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const deviceId = typeof raw['deviceId'] === 'string' ? raw['deviceId'].trim() : ''
    const label = typeof raw['label'] === 'string' ? raw['label'].replace(/\s+/g, ' ').trim() : ''
    const platform = typeof raw['platform'] === 'string' ? raw['platform'].slice(0, 160) : ''
    if (!DEVICE_ID_RE.test(deviceId) || label.length < 1 || label.length > 64) {
      return c.json({ error: 'Invalid device registration', errorCode: 'INVALID_DEVICE' }, 400)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.device.register',
      actorBeamId: auth.agent.beam_id,
      deviceId,
      label,
      platform,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO beam_devices (device_id, beam_id, label, platform, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        label = excluded.label,
        platform = excluded.platform,
        last_seen_at = excluded.last_seen_at
      WHERE beam_devices.beam_id = excluded.beam_id
    `).run(deviceId, auth.agent.beam_id, label, platform || null, now, now)
    const device = db.prepare(`
      SELECT device_id, label, platform, created_at, last_seen_at FROM beam_devices WHERE device_id = ? AND beam_id = ?
    `).get(deviceId, auth.agent.beam_id)
    if (!device) return c.json({ error: 'Device ID belongs to another identity', errorCode: 'DEVICE_CONFLICT' }, 409)
    broadcastNetworkEvent([auth.agent.beam_id], {
      type: 'network.device.updated',
      deviceId,
      action: 'registered',
    })
    return c.json({ device: {
      deviceId,
      label,
      platform: platform || null,
      createdAt: (device as { created_at: string }).created_at,
      lastSeenAt: (device as { last_seen_at: string }).last_seen_at,
    } }, 201)
  })

  router.delete('/devices/:deviceId', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const deviceId = c.req.param('deviceId')
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.device.remove',
      actorBeamId: auth.agent.beam_id,
      deviceId,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    const result = db.prepare('DELETE FROM beam_devices WHERE device_id = ? AND beam_id = ?').run(deviceId, auth.agent.beam_id)
    if (result.changes === 0) return c.json({ error: 'Device not found', errorCode: 'DEVICE_NOT_FOUND' }, 404)
    broadcastNetworkEvent([auth.agent.beam_id], {
      type: 'network.device.updated',
      deviceId,
      action: 'removed',
    })
    return c.json({ removed: true })
  })

  router.get('/notifications/config', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    return c.json(configurePush())
  })

  router.post('/notifications/subscriptions', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const deviceId = typeof raw['deviceId'] === 'string' ? raw['deviceId'].trim() : ''
    const endpoint = typeof raw['endpoint'] === 'string' ? raw['endpoint'].trim() : ''
    const p256dh = typeof raw['p256dh'] === 'string' ? raw['p256dh'].trim() : ''
    const authSecret = typeof raw['auth'] === 'string' ? raw['auth'].trim() : ''
    const ownsDevice = db.prepare('SELECT 1 FROM beam_devices WHERE device_id = ? AND beam_id = ?').get(deviceId, auth.agent.beam_id)
    if (!ownsDevice || !endpoint.startsWith('https://') || endpoint.length > 2_048 || p256dh.length < 32 || authSecret.length < 16) {
      return c.json({ error: 'Invalid push subscription', errorCode: 'INVALID_SUBSCRIPTION' }, 400)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.notification.subscribe',
      actorBeamId: auth.agent.beam_id,
      deviceId,
      endpoint,
      p256dh,
      auth: authSecret,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    const now = new Date().toISOString()
    const subscriptionId = createHash('sha256').update(endpoint).digest('hex')
    const upserted = db.prepare(`
      INSERT INTO beam_push_subscriptions (
        subscription_id, beam_id, device_id, endpoint, p256dh, auth_secret, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        beam_id = excluded.beam_id,
        device_id = excluded.device_id,
        p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        updated_at = excluded.updated_at
      WHERE beam_push_subscriptions.beam_id = excluded.beam_id
    `).run(subscriptionId, auth.agent.beam_id, deviceId, endpoint, p256dh, authSecret, now, now)
    if (upserted.changes === 0) {
      return c.json({ error: 'This push endpoint belongs to another identity', errorCode: 'SUBSCRIPTION_CONFLICT' }, 409)
    }
    return c.json({ subscribed: true, enabled: configurePush().enabled }, 201)
  })

  router.delete('/notifications/subscriptions', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    const endpoint = typeof raw['endpoint'] === 'string' ? raw['endpoint'].trim() : ''
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.notification.unsubscribe',
      actorBeamId: auth.agent.beam_id,
      endpoint,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    db.prepare('DELETE FROM beam_push_subscriptions WHERE endpoint = ? AND beam_id = ?').run(endpoint, auth.agent.beam_id)
    return c.json({ subscribed: false })
  })

  return router
}
