import {
  enrollDeviceVault,
  forgetDeviceVault,
  getDeviceVaultMetadata,
  isDeviceVaultCapable,
  unlockDeviceVault,
  updateDeviceVault,
} from './device-vault.js'
import {
  base64ToBytes as encryptedBase64ToBytes,
  decryptNetworkPayload,
  encryptNetworkPayload,
  generateNetworkEncryptionIdentity,
  importNetworkEncryptionPrivateKey,
} from './network-crypto.js'

;(function () {
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  const API_BASE = local ? 'http://localhost:3100' : 'https://api.beam.directory'
  const WS_BASE = local ? 'ws://localhost:3100' : 'wss://api.beam.directory'
  const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024
  const ALLOWED_ATTACHMENT_TYPES = new Set([
    'application/pdf', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
  ])

  const $ = (id) => document.getElementById(id)
  const elements = {
    unlock: $('unlock-shell'), app: $('network-app'), loading: $('app-loading'), unlockError: $('unlock-error'),
    kitInput: $('kit-input'), kitDrop: $('kit-drop'), deviceUnlock: $('device-unlock'),
    deviceUnlockBeamId: $('device-unlock-beam-id'), vaultDivider: $('vault-divider'), identityMenu: $('identity-menu'),
    toast: $('toast'), conversationList: $('conversation-list'), connectionsList: $('connections-list'),
    inboundList: $('inbound-list'), outboundList: $('outbound-list'), searchForm: $('beam-search'),
    searchQuery: $('search-query'), searchList: $('search-list'), globalSearch: $('global-search'),
    conversationEmpty: $('conversation-empty'), conversationActive: $('conversation-active'),
    messageStream: $('message-stream'), messageForm: $('message-form'), messageInput: $('message-input'),
    attachmentInput: $('attachment-input'), attachmentPreview: $('attachment-preview'), clearAttachment: $('clear-attachment'),
    recordAudio: $('record-audio'), recordLabel: $('record-label'), newGroup: $('new-group'),
    groupDialog: $('group-dialog'), groupForm: $('group-form'), groupContactList: $('group-contact-list'),
    deviceList: $('device-list'), deviceVaultAction: $('device-vault-action'), enableNotifications: $('enable-notifications'),
    detailPane: $('detail-pane'), detailsToggle: $('details-toggle'), detailClose: $('detail-close'),
    backToList: $('back-to-list'), openSettings: $('open-settings'),
  }

  const state = {
    kit: null,
    privateKey: null,
    encryptionPrivateKey: null,
    me: null,
    connections: [],
    conversations: [],
    messages: [],
    devices: [],
    activeConversationId: null,
    pendingAttachment: null,
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    vaultMetadata: null,
    mediaRecorder: null,
    recordingStream: null,
    recordingChunks: [],
    toastTimer: null,
    objectUrls: new Set(),
  }

  function setText(id, value) {
    const element = $(id)
    if (element) element.textContent = String(value ?? '')
  }

  function initials(value) {
    return String(value || 'Beam').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  }

  function kindLabel(kind) {
    if (kind === 'person') return 'PERSON'
    if (kind === 'organization') return 'COMPANY'
    if (kind === 'service') return 'SERVICE'
    return 'AGENT'
  }

  function relativeTime(value) {
    if (!value) return ''
    const delta = Date.now() - Date.parse(value)
    if (!Number.isFinite(delta)) return ''
    if (delta < 60_000) return 'now'
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }

  function showLoading(show, message) {
    if (!elements.loading) return
    const copy = elements.loading.querySelector('p')
    if (copy && message) copy.textContent = message
    elements.loading.hidden = !show
  }

  function showUnlockError(message) {
    elements.unlockError.textContent = message || ''
    elements.unlockError.hidden = !message
  }

  function toast(message, error) {
    if (state.toastTimer) window.clearTimeout(state.toastTimer)
    elements.toast.textContent = message
    elements.toast.classList.toggle('is-error', Boolean(error))
    elements.toast.hidden = false
    state.toastTimer = window.setTimeout(() => { elements.toast.hidden = true }, 4200)
  }

  function setNetworkState(online, label) {
    const wrapper = $('network-state-label')?.parentElement
    wrapper?.classList.toggle('is-online', online)
    setText('network-state-label', label || (online ? 'Live' : 'Offline'))
  }

  function base64ToBytes(value) {
    const binary = window.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    let binary = ''
    const chunkSize = 32_768
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return window.btoa(binary)
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
      const sorted = {}
      for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key])
      return sorted
    }
    return value
  }

  function createNonce() {
    const bytes = new Uint8Array(24)
    window.crypto.getRandomValues(bytes)
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }

  async function signMutation(payload) {
    if (!state.privateKey) throw new Error('Your private identity key is not open.')
    const signed = { ...payload, timestamp: new Date().toISOString(), nonce: createNonce() }
    const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(signed)))
    const signature = await window.crypto.subtle.sign('Ed25519', state.privateKey, encoded)
    return { ...signed, signature: bytesToBase64(signature) }
  }

  async function api(path, options = {}) {
    const apiKey = state.kit?.credential?.apiKey
    if (!apiKey) throw new Error('Open your Beam first.')
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    })
    let payload = {}
    try { payload = await response.json() } catch { payload = {} }
    if (!response.ok) {
      const error = new Error(payload.error || 'Beam could not complete this request.')
      error.code = payload.errorCode || 'REQUEST_FAILED'
      error.status = response.status
      throw error
    }
    return payload
  }

  async function fetchAttachment(attachment) {
    if (attachment.dataBase64) {
      return new Blob([encryptedBase64ToBytes(attachment.dataBase64)], { type: attachment.mimeType })
    }
    const response = await fetch(`${API_BASE}${attachment.url}`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${state.kit.credential.apiKey}` },
    })
    if (!response.ok) throw new Error('Beam could not open this attachment.')
    return response.blob()
  }

  function validateKit(kit) {
    const valid = kit && typeof kit === 'object' && kit.format === 'beam-identity-recovery' && kit.version === 1
      && typeof kit.beamId === 'string' && kit.beamId.endsWith('.directory')
      && kit.identity?.algorithm === 'Ed25519' && typeof kit.identity.publicKey === 'string'
      && typeof kit.identity.privateKey === 'string' && typeof kit.credential?.apiKey === 'string'
      && kit.credential.apiKey.startsWith('bk_')
    if (!valid) throw new Error('This is not a valid Beam recovery kit.')
  }

  async function ensureEncryptionIdentity(kit) {
    if (kit.identity.encryption) {
      return importNetworkEncryptionPrivateKey(kit.identity.encryption)
    }

    if (!isDeviceVaultCapable()) {
      throw new Error('This older Beam identity needs a passkey-capable browser for its one-time encryption upgrade.')
    }
    const encryption = await generateNetworkEncryptionIdentity()
    const upgradedKit = {
      ...kit,
      identity: { ...kit.identity, encryption },
      upgradedAt: new Date().toISOString(),
    }
    const existingVault = await getDeviceVaultMetadata()
    if (existingVault?.beamId === kit.beamId) await updateDeviceVault(upgradedKit)
    else if (!existingVault) await enrollDeviceVault(upgradedKit)
    else throw new Error('This browser already protects another Beam identity. Use a separate browser profile for this upgrade.')

    kit.identity = upgradedKit.identity
    kit.upgradedAt = upgradedKit.upgradedAt
    await api(`/agents/${encodeURIComponent(kit.beamId)}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ dhPublicKey: encryption.publicKey }),
    })
    return importNetworkEncryptionPrivateKey(encryption)
  }

  async function reconcileDirectoryEncryptionKey(kit) {
    const current = await api('/network/me')
    if (current.identity?.beamId !== kit.beamId) {
      throw new Error('This credential belongs to another Beam ID.')
    }
    const expected = kit.identity.encryption?.publicKey
    if (!expected) throw new Error('This Beam identity has no encryption public key.')
    if (current.identity.dhPublicKey !== expected) {
      await api(`/agents/${encodeURIComponent(kit.beamId)}/config`, {
        method: 'PATCH',
        body: JSON.stringify({ dhPublicKey: expected }),
      })
    }
  }

  async function validateDecryptedAttachment(attachment) {
    if (!attachment) return null
    const metadata = attachment.metadata
    if (
      !metadata
      || typeof metadata.name !== 'string'
      || typeof metadata.mimeType !== 'string'
      || !ALLOWED_ATTACHMENT_TYPES.has(metadata.mimeType)
      || !Number.isSafeInteger(metadata.byteSize)
      || metadata.byteSize < 1
      || metadata.byteSize > MAX_ATTACHMENT_BYTES
      || typeof metadata.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || typeof attachment.dataBase64 !== 'string'
    ) throw new Error('An encrypted attachment is invalid.')
    const bytes = encryptedBase64ToBytes(attachment.dataBase64)
    if (bytes.byteLength !== metadata.byteSize) throw new Error('An encrypted attachment has the wrong size.')
    const digest = await window.crypto.subtle.digest('SHA-256', bytes)
    const actual = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== metadata.sha256) throw new Error('An encrypted attachment failed its integrity check.')
    return { ...metadata, dataBase64: attachment.dataBase64 }
  }

  async function decryptMessage(message) {
    if (!message?.encrypted) return message
    if (!state.encryptionPrivateKey || !state.me) throw new Error('Your Beam encryption key is not open.')
    const payload = await decryptNetworkPayload({
      conversationId: message.conversationId,
      senderBeamId: message.senderBeamId,
      recipientBeamId: state.me.identity.beamId,
      privateKey: state.encryptionPrivateKey,
      envelope: message.encrypted,
    })
    const body = typeof payload?.body === 'string' ? payload.body.trim() : ''
    if (body.length > 4_000) throw new Error('An encrypted message is too long.')
    const attachment = await validateDecryptedAttachment(payload?.attachment)
    if (!body && !attachment) throw new Error('An encrypted message is empty.')
    return {
      ...message,
      body,
      attachment,
      endToEndEncrypted: true,
    }
  }

  async function decryptMessages(messages) {
    return Promise.all(messages.map(async (message) => {
      try { return await decryptMessage(message) } catch { return { ...message, body: 'Unable to decrypt this message.', attachment: null, decryptionFailed: true } }
    }))
  }

  async function hydrateConversationPreviews(conversations) {
    await Promise.all(conversations.map(async (conversation) => {
      if (!conversation.lastMessage?.encrypted) return
      try { conversation.lastMessage = await decryptMessage(conversation.lastMessage) } catch { conversation.lastMessage = { ...conversation.lastMessage, body: 'Encrypted message' } }
    }))
    return conversations
  }

  async function importAndVerifyKeys(kit) {
    if (!window.crypto?.subtle) throw new Error('This browser cannot open a secure Beam identity.')
    try {
      const [privateKey, publicKey] = await Promise.all([
        window.crypto.subtle.importKey('pkcs8', base64ToBytes(kit.identity.privateKey), { name: 'Ed25519' }, false, ['sign']),
        window.crypto.subtle.importKey('spki', base64ToBytes(kit.identity.publicKey), { name: 'Ed25519' }, false, ['verify']),
      ])
      const challenge = new TextEncoder().encode(`beam-kit-check:${kit.beamId}`)
      const signature = await window.crypto.subtle.sign('Ed25519', privateKey, challenge)
      const verified = await window.crypto.subtle.verify('Ed25519', publicKey, signature, challenge)
      if (!verified) throw new Error('Key mismatch')
      return privateKey
    } catch {
      throw new Error('This recovery kit is damaged or contains mismatched identity keys.')
    }
  }

  function emptyNode(title, detail) {
    const wrapper = document.createElement('div')
    wrapper.className = 'list-empty'
    const heading = document.createElement('strong')
    const copy = document.createElement('small')
    heading.textContent = title
    copy.textContent = detail
    wrapper.append(heading, copy)
    return wrapper
  }

  function avatarNode(label, online, group) {
    const avatar = document.createElement('span')
    avatar.className = `list-avatar${group ? ' is-group' : ''}`
    avatar.textContent = initials(label)
    if (!group) {
      const presence = document.createElement('i')
      presence.classList.toggle('is-online', Boolean(online))
      avatar.append(presence)
    }
    return avatar
  }

  function showRailView(name) {
    document.querySelectorAll('[data-rail-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.railView === name))
    document.querySelectorAll('[data-rail-panel]').forEach((panel) => { panel.hidden = panel.dataset.railPanel !== name })
  }

  function activeConversation() {
    return state.conversations.find((conversation) => conversation.conversationId === state.activeConversationId) || null
  }

  function renderConversations() {
    elements.conversationList.replaceChildren()
    const filtered = filterConversations(state.conversations)
    if (filtered.length === 0) {
      elements.conversationList.append(emptyNode('No conversations yet.', 'Open a trusted contact or create an agent team.'))
    }
    for (const conversation of filtered) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `conversation-item${conversation.conversationId === state.activeConversationId ? ' is-active' : ''}`
      const avatar = avatarNode(conversation.title, conversation.online, conversation.kind === 'group')
      const copy = document.createElement('div')
      const title = document.createElement('strong')
      const preview = document.createElement('small')
      title.textContent = conversation.title || 'Conversation'
      const last = conversation.lastMessage
      preview.textContent = last ? (last.body || (last.type === 'audio' ? 'Audio message' : 'Shared a file')) : (conversation.kind === 'group' ? `${conversation.members.length} members` : 'New connection')
      copy.append(title, preview)
      const meta = document.createElement('span')
      meta.className = 'conversation-meta'
      const time = document.createElement('time')
      time.textContent = relativeTime(last?.createdAt || conversation.updatedAt)
      meta.append(time)
      if (conversation.unread > 0) {
        const unread = document.createElement('i')
        unread.className = 'unread-badge'
        unread.textContent = conversation.unread > 99 ? '99+' : String(conversation.unread)
        meta.append(unread)
      }
      button.append(avatar, copy, meta)
      button.addEventListener('click', () => openConversation(conversation.conversationId).catch(showActionError))
      elements.conversationList.append(button)
    }
    const unread = state.conversations.reduce((sum, conversation) => sum + conversation.unread, 0)
    setText('unread-total', unread)
  }

  function filterConversations(conversations) {
    const query = elements.globalSearch?.value.trim().toLowerCase() || ''
    if (!query) return conversations
    return conversations.filter((conversation) => {
      const memberText = conversation.members.map((member) => `${member.beamId} ${member.profile?.displayName || ''}`).join(' ')
      return `${conversation.title || ''} ${memberText}`.toLowerCase().includes(query)
    })
  }

  function actionButton(label, className, handler) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.className = className || ''
    button.addEventListener('click', async () => {
      button.disabled = true
      try { await handler() } catch (error) { showActionError(error) } finally { button.disabled = false }
    })
    return button
  }

  function contactRow(profile, connection, context) {
    const row = document.createElement('article')
    row.className = 'contact-row'
    row.append(avatarNode(profile.displayName, connection?.online, false))
    const main = document.createElement('div')
    main.className = 'contact-row-main'
    const copy = document.createElement('div')
    const name = document.createElement('strong')
    const beamId = document.createElement('small')
    name.textContent = profile.displayName
    beamId.textContent = profile.beamId
    copy.append(name, beamId)
    const actions = document.createElement('div')
    actions.className = 'contact-actions'
    if (context === 'contact') {
      actions.append(actionButton('Message', 'primary', () => openDirectConversation(profile.beamId)))
    } else if (context === 'search') {
      if (!connection || ['declined', 'cancelled'].includes(connection.status)) actions.append(actionButton('Connect', 'primary', () => requestConnection(profile.beamId)))
      else if (connection.status === 'accepted') actions.append(actionButton('Message', 'primary', () => openDirectConversation(profile.beamId)))
      else {
        const status = document.createElement('small')
        status.textContent = connection.status.toUpperCase()
        actions.append(status)
      }
    } else if (connection.direction === 'inbound') {
      actions.append(
        actionButton('Accept', 'primary', () => respondConnection(connection.connectionId, 'accepted')),
        actionButton('Decline', '', () => respondConnection(connection.connectionId, 'declined')),
      )
    } else {
      actions.append(actionButton('Cancel', 'danger', () => removeConnection(connection.connectionId)))
    }
    main.append(copy, actions)
    row.append(main)
    return row
  }

  function renderConnections() {
    const contacts = state.connections.filter((connection) => connection.status === 'accepted')
    const inbound = state.connections.filter((connection) => connection.status === 'pending' && connection.direction === 'inbound')
    const outbound = state.connections.filter((connection) => connection.status === 'pending' && connection.direction === 'outbound')
    const render = (container, rows, emptyTitle, context) => {
      container.replaceChildren()
      if (rows.length === 0) container.append(emptyNode(emptyTitle, context === 'contact' ? 'Search for a verified Beam identity above.' : 'Nothing needs your attention.'))
      for (const row of rows) if (row.counterpart) container.append(contactRow(row.counterpart, row, context))
    }
    render(elements.connectionsList, contacts, 'No connections yet.', 'contact')
    render(elements.inboundList, inbound, 'Nothing waiting.', 'request')
    render(elements.outboundList, outbound, 'No sent requests.', 'request')
    setText('contacts-count', contacts.length)
    setText('requests-count', inbound.length)
    setText('inbound-count', inbound.length)
    setText('outbound-count', outbound.length)
    renderGroupChoices(contacts)
  }

  function renderGroupChoices(contacts) {
    elements.groupContactList.replaceChildren()
    if (contacts.length === 0) {
      elements.groupContactList.append(emptyNode('No trusted contacts.', 'Connect with someone before creating a group.'))
      return
    }
    for (const connection of contacts) {
      const profile = connection.counterpart
      const label = document.createElement('label')
      label.className = 'group-choice'
      const avatar = document.createElement('span')
      avatar.textContent = initials(profile.displayName)
      const copy = document.createElement('div')
      const name = document.createElement('strong')
      const beamId = document.createElement('small')
      name.textContent = profile.displayName
      beamId.textContent = profile.beamId
      copy.append(name, beamId)
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.name = 'group-member'
      checkbox.value = profile.beamId
      label.append(avatar, copy, checkbox)
      elements.groupContactList.append(label)
    }
  }

  function messageAuthor(message, conversation) {
    return conversation.members.find((member) => member.beamId === message.senderBeamId)?.profile || { displayName: message.senderBeamId }
  }

  function renderMessages() {
    elements.messageStream.replaceChildren()
    const conversation = activeConversation()
    if (!conversation) return
    if (state.messages.length === 0) elements.messageStream.append(emptyNode('A clean beginning.', 'Send the first signed message in this conversation.'))
    let lastDay = ''
    for (const message of state.messages) {
      const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(message.createdAt))
      if (day !== lastDay) {
        const divider = document.createElement('div')
        divider.className = 'day-divider'
        divider.textContent = day
        elements.messageStream.append(divider)
        lastDay = day
      }
      const mine = message.senderBeamId === state.me.identity.beamId
      const article = document.createElement('article')
      article.className = `message${mine ? ' is-mine' : ''}`
      const author = messageAuthor(message, conversation)
      if (!mine) {
        const avatar = document.createElement('span')
        avatar.className = 'message-avatar'
        avatar.textContent = initials(author.displayName)
        article.append(avatar)
      }
      const content = document.createElement('div')
      content.className = 'message-content'
      const byline = document.createElement('p')
      byline.className = 'message-byline'
      const authorName = document.createElement('strong')
      authorName.textContent = mine ? 'You' : author.displayName
      const time = document.createElement('time')
      time.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))
      byline.append(authorName, time)
      const bubble = document.createElement('div')
      bubble.className = 'message-bubble'
      if (message.body) bubble.append(document.createTextNode(message.body))
      if (message.attachment) bubble.append(attachmentCard(message.attachment, message.type))
      content.append(byline, bubble)
      article.append(content)
      elements.messageStream.append(article)
    }
    requestAnimationFrame(() => { elements.messageStream.scrollTop = elements.messageStream.scrollHeight })
  }

  function attachmentCard(attachment, messageType) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'attachment-card'
    const icon = document.createElement('span')
    icon.textContent = messageType === 'audio' ? '◉' : attachment.mimeType.startsWith('image/') ? '▧' : '↗'
    const copy = document.createElement('div')
    const name = document.createElement('strong')
    const meta = document.createElement('small')
    name.textContent = attachment.name
    meta.textContent = `${formatBytes(attachment.byteSize)} · ${messageType === 'audio' ? 'PLAY AUDIO' : 'OPEN FILE'}`
    copy.append(name, meta)
    const arrow = document.createElement('i')
    arrow.textContent = '→'
    button.append(icon, copy, arrow)
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        const blob = await fetchAttachment(attachment)
        const url = URL.createObjectURL(blob)
        state.objectUrls.add(url)
        if (messageType === 'audio') {
          const audio = new Audio(url)
          audio.addEventListener('ended', () => { URL.revokeObjectURL(url); state.objectUrls.delete(url) }, { once: true })
          await audio.play()
        } else {
          window.open(url, '_blank', 'noopener,noreferrer')
          window.setTimeout(() => { URL.revokeObjectURL(url); state.objectUrls.delete(url) }, 60_000)
        }
      } catch (error) { showActionError(error) } finally { button.disabled = false }
    })
    return button
  }

  function renderActiveConversation() {
    const conversation = activeConversation()
    elements.conversationEmpty.hidden = Boolean(conversation)
    elements.conversationActive.hidden = !conversation
    elements.app.classList.toggle('has-active-chat', Boolean(conversation))
    if (!conversation) return
    const counterpart = conversation.counterpart
    setText('chat-avatar', initials(conversation.title))
    setText('chat-title', conversation.title)
    const presenceText = conversation.kind === 'group'
      ? `${conversation.members.length} members · ${conversation.members.filter((member) => member.online).length} online`
      : conversation.online ? 'Online now' : 'Offline · messages will sync'
    setText('chat-presence', presenceText)
    const presence = $('chat-presence')?.parentElement
    presence?.classList.toggle('is-online', conversation.online)
    setText('detail-avatar', initials(conversation.title))
    setText('detail-name', conversation.title)
    setText('detail-beam-id', counterpart?.beamId || (conversation.kind === 'group' ? `beam:group/${conversation.conversationId.slice(0, 8)}` : ''))
    setText('detail-kind', conversation.kind === 'group' ? 'AGENT TEAM' : kindLabel(counterpart?.profile?.identityKind))
    $('members-section').hidden = conversation.kind !== 'group'
    setText('member-count', conversation.members.length)
    renderMembers(conversation.members)
    renderConversations()
  }

  function renderMembers(members) {
    const list = $('member-list')
    list.replaceChildren()
    for (const member of members) {
      const row = document.createElement('div')
      row.className = 'member-row'
      const avatar = document.createElement('span')
      avatar.textContent = initials(member.profile?.displayName || member.beamId)
      const copy = document.createElement('div')
      const name = document.createElement('strong')
      const role = document.createElement('small')
      name.textContent = member.profile?.displayName || member.beamId
      role.textContent = `${member.role.toUpperCase()} · ${member.profile ? kindLabel(member.profile.identityKind) : 'BEAM'}`
      copy.append(name, role)
      const dot = document.createElement('i')
      dot.classList.toggle('is-online', member.online)
      row.append(avatar, copy, dot)
      list.append(row)
    }
  }

  function renderDevices() {
    elements.deviceList.replaceChildren()
    const currentId = getDeviceId(false)
    if (state.devices.length === 0) elements.deviceList.append(emptyNode('No registered devices.', 'This browser will appear after it is signed in.'))
    for (const device of state.devices) {
      const row = document.createElement('div')
      row.className = 'device-row'
      const icon = document.createElement('span')
      icon.textContent = device.deviceId === currentId ? '◎' : '◇'
      const copy = document.createElement('div')
      const label = document.createElement('strong')
      const seen = document.createElement('small')
      label.textContent = device.label
      seen.textContent = device.deviceId === currentId ? 'THIS DEVICE' : `SEEN ${relativeTime(device.lastSeenAt).toUpperCase()}`
      copy.append(label, seen)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '×'
      remove.title = 'Remove device'
      remove.addEventListener('click', () => removeDevice(device.deviceId).catch(showActionError))
      row.append(icon, copy, remove)
      elements.deviceList.append(row)
    }
    setText('device-count', `${state.devices.length} DEVICE${state.devices.length === 1 ? '' : 'S'}`)
  }

  async function refreshNetwork() {
    const [me, connections, conversations, devices] = await Promise.all([
      api('/network/me'), api('/network/connections'), api('/network/conversations'), api('/network/devices'),
    ])
    state.me = me
    state.connections = connections.connections || []
    state.conversations = await hydrateConversationPreviews(conversations.conversations || [])
    state.devices = devices.devices || []
    if (state.activeConversationId && !state.conversations.some((item) => item.conversationId === state.activeConversationId)) state.activeConversationId = null
    renderIdentity()
    renderConnections()
    renderConversations()
    renderDevices()
    renderActiveConversation()
  }

  function renderIdentity() {
    if (!state.me) return
    const identity = state.me.identity
    setText('header-avatar', initials(identity.displayName))
    setText('header-name', identity.displayName)
    setText('own-beam-id', identity.beamId)
  }

  async function openConversation(conversationId) {
    state.activeConversationId = conversationId
    renderActiveConversation()
    const result = await api(`/network/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`)
    state.messages = await decryptMessages(result.messages || [])
    renderMessages()
    const body = await signMutation({ type: 'network.conversation.read', conversationId, actorBeamId: state.me.identity.beamId })
    await api(`/network/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST', body: JSON.stringify(body) })
    const current = state.conversations.find((item) => item.conversationId === conversationId)
    if (current) current.unread = 0
    renderConversations()
    elements.messageInput.focus()
  }

  async function openDirectConversation(counterpartBeamId) {
    const body = await signMutation({ type: 'network.conversation.direct', actorBeamId: state.me.identity.beamId, counterpartBeamId })
    const result = await api('/network/conversations/direct', { method: 'POST', body: JSON.stringify(body) })
    await refreshNetwork()
    showRailView('messages')
    await openConversation(result.conversation.conversationId)
  }

  async function requestConnection(recipientBeamId) {
    const body = await signMutation({ type: 'network.connection.request', requesterBeamId: state.me.identity.beamId, recipientBeamId, message: '' })
    await api('/network/connections', { method: 'POST', body: JSON.stringify(body) })
    await refreshNetwork()
    toast(`Connection request sent to ${recipientBeamId}.`)
  }

  async function respondConnection(connectionId, decision) {
    const body = await signMutation({ type: 'network.connection.respond', connectionId, actorBeamId: state.me.identity.beamId, decision })
    await api(`/network/connections/${encodeURIComponent(connectionId)}/respond`, { method: 'POST', body: JSON.stringify(body) })
    await refreshNetwork()
    toast(decision === 'accepted' ? 'Connection confirmed. You can message now.' : 'Request declined.')
  }

  async function removeConnection(connectionId) {
    const body = await signMutation({ type: 'network.connection.remove', connectionId, actorBeamId: state.me.identity.beamId })
    await api(`/network/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE', body: JSON.stringify(body) })
    await refreshNetwork()
    toast('Connection removed.')
  }

  async function runSearch(queryOverride) {
    const query = String(queryOverride ?? elements.searchQuery.value).trim()
    if (query.length < 3) return
    const result = await api(`/network/discover?q=${encodeURIComponent(query)}`)
    elements.searchList.replaceChildren()
    if (!result.results?.length) elements.searchList.append(emptyNode('No identity found.', 'Private identities require their complete Beam ID.'))
    for (const item of result.results || []) elements.searchList.append(contactRow(item.identity, item.connection, 'search'))
  }

  async function createGroup() {
    const title = $('group-name').value.replace(/\s+/g, ' ').trim()
    const memberBeamIds = Array.from(elements.groupContactList.querySelectorAll('input:checked')).map((input) => input.value)
    if (title.length < 2 || memberBeamIds.length < 1) throw new Error('Choose a group name and at least one trusted contact.')
    const body = await signMutation({ type: 'network.group.create', actorBeamId: state.me.identity.beamId, title, memberBeamIds })
    const result = await api('/network/groups', { method: 'POST', body: JSON.stringify(body) })
    elements.groupDialog.close()
    elements.groupForm.reset()
    await refreshNetwork()
    await openConversation(result.conversation.conversationId)
    toast('Agent team created.')
  }

  async function fileToAttachment(file) {
    if (!file || file.size < 1) throw new Error('Choose a non-empty file.')
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments can be up to 6 MB.')
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) throw new Error('Beam supports images, PDF, text, and common audio files.')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = await window.crypto.subtle.digest('SHA-256', bytes)
    return {
      file,
      metadata: {
        name: file.name || `beam-file-${Date.now()}`,
        mimeType: file.type || 'application/octet-stream',
        byteSize: file.size,
        sha256: Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      },
      dataBase64: bytesToBase64(bytes),
    }
  }

  function renderAttachmentPreview() {
    const pending = state.pendingAttachment
    elements.attachmentPreview.hidden = !pending
    if (!pending) return
    setText('attachment-preview-icon', pending.metadata.mimeType.startsWith('audio/') ? '◉' : '↗')
    setText('attachment-preview-name', pending.metadata.name)
    setText('attachment-preview-meta', `${formatBytes(pending.metadata.byteSize)} · ready to send`)
  }

  async function sendMessage() {
    const conversation = activeConversation()
    if (!conversation) return
    const bodyText = elements.messageInput.value.trim()
    const pending = state.pendingAttachment
    if (!bodyText && !pending) return
    const messageType = pending?.metadata.mimeType.startsWith('audio/') ? 'audio' : pending ? 'file' : 'text'
    const encrypted = await encryptNetworkPayload({
      conversationId: conversation.conversationId,
      senderBeamId: state.me.identity.beamId,
      recipients: conversation.members.map((member) => ({
        beamId: member.beamId,
        dhPublicKey: member.profile?.dhPublicKey,
      })),
      payload: {
        body: bodyText,
        messageType,
        attachment: pending ? { metadata: pending.metadata, dataBase64: pending.dataBase64 } : null,
      },
    })
    const proofBody = await signMutation({
      type: 'network.message.send',
      conversationId: conversation.conversationId,
      senderBeamId: state.me.identity.beamId,
      body: '',
      messageType,
      attachment: null,
      encrypted,
      automationDepth: 0,
    })
    elements.messageInput.value = ''
    elements.messageInput.style.height = ''
    clearPendingAttachment()
    const result = await api(`/network/conversations/${encodeURIComponent(conversation.conversationId)}/messages`, { method: 'POST', body: JSON.stringify(proofBody) })
    if (!state.messages.some((message) => message.messageId === result.message.messageId)) state.messages.push(await decryptMessage(result.message))
    renderMessages()
    await refreshConversations()
  }

  function clearPendingAttachment() {
    state.pendingAttachment = null
    elements.attachmentInput.value = ''
    renderAttachmentPreview()
  }

  async function startOrStopRecording() {
    if (state.mediaRecorder?.state === 'recording') {
      state.mediaRecorder.stop()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Audio recording is not supported in this browser.')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type)) || ''
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
    state.mediaRecorder = recorder
    state.recordingStream = stream
    state.recordingChunks = []
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) state.recordingChunks.push(event.data) })
    recorder.addEventListener('stop', async () => {
      elements.recordAudio.classList.remove('is-recording')
      setText('record-label', 'Audio')
      state.recordingStream?.getTracks().forEach((track) => track.stop())
      const mimeType = recorder.mimeType.split(';')[0] || 'audio/webm'
      const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm'
      const blob = new Blob(state.recordingChunks, { type: mimeType })
      try {
        state.pendingAttachment = await fileToAttachment(new File([blob], `beam-audio-${Date.now()}.${extension}`, { type: mimeType }))
        renderAttachmentPreview()
      } catch (error) { showActionError(error) }
      state.mediaRecorder = null
      state.recordingStream = null
      state.recordingChunks = []
    }, { once: true })
    recorder.start(500)
    elements.recordAudio.classList.add('is-recording')
    setText('record-label', 'Stop')
    window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop() }, 60_000)
  }

  async function refreshConversations() {
    const result = await api('/network/conversations')
    state.conversations = await hydrateConversationPreviews(result.conversations || [])
    renderConversations()
    renderActiveConversation()
  }

  function getDeviceId(create = true) {
    const storageKey = state.me ? `beam.network.device.${state.me.identity.beamId}` : 'beam.network.device.pending'
    let value = window.localStorage.getItem(storageKey)
    if (!value && create) {
      value = window.crypto.randomUUID().replace(/-/g, '')
      window.localStorage.setItem(storageKey, value)
    }
    return value
  }

  function deviceLabel() {
    const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent)
    const browser = /Firefox/i.test(navigator.userAgent) ? 'Firefox' : /Edg/i.test(navigator.userAgent) ? 'Edge' : /Chrome/i.test(navigator.userAgent) ? 'Chrome' : /Safari/i.test(navigator.userAgent) ? 'Safari' : 'Browser'
    return `${mobile ? 'Mobile' : 'Desktop'} · ${browser}`
  }

  async function registerDevice() {
    const deviceId = getDeviceId(true)
    const label = deviceLabel()
    const platform = String(navigator.userAgentData?.platform || navigator.platform || '').slice(0, 160)
    const body = await signMutation({ type: 'network.device.register', actorBeamId: state.me.identity.beamId, deviceId, label, platform })
    await api('/network/devices', { method: 'POST', body: JSON.stringify(body) })
  }

  async function removeDevice(deviceId) {
    const own = deviceId === getDeviceId(false)
    const body = await signMutation({ type: 'network.device.remove', actorBeamId: state.me.identity.beamId, deviceId })
    await api(`/network/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', body: JSON.stringify(body) })
    if (own) window.localStorage.removeItem(`beam.network.device.${state.me.identity.beamId}`)
    const devices = await api('/network/devices')
    state.devices = devices.devices || []
    renderDevices()
    toast('Device removed from this Beam identity.')
  }

  async function connectRealtime() {
    if (!state.me || !state.kit) return
    if (state.socket) {
      state.socket.onclose = null
      state.socket.close()
    }
    setNetworkState(false, 'Connecting')
    try {
      const beamId = state.me.identity.beamId
      const ticket = await api(`/agents/${encodeURIComponent(beamId)}/ws-ticket`, { method: 'POST' })
      const socket = new WebSocket(`${WS_BASE}/ws?beamId=${encodeURIComponent(beamId)}&ticket=${encodeURIComponent(ticket.ticket)}`)
      state.socket = socket
      socket.addEventListener('open', () => {
        state.reconnectAttempt = 0
        setNetworkState(true, 'Live')
      })
      socket.addEventListener('message', (event) => { void handleRealtimeEvent(event.data) })
      socket.addEventListener('close', () => {
        if (state.socket !== socket || !state.kit) return
        setNetworkState(false, 'Reconnecting')
        const delay = Math.min(30_000, 1_000 * (2 ** state.reconnectAttempt++))
        state.reconnectTimer = window.setTimeout(() => connectRealtime().catch(() => {}), delay)
      })
      socket.addEventListener('error', () => setNetworkState(false, 'Reconnecting'))
    } catch {
      setNetworkState(false, 'Reconnecting')
      state.reconnectTimer = window.setTimeout(() => connectRealtime().catch(() => {}), 3_000)
    }
  }

  async function handleRealtimeEvent(raw) {
    let event
    try { event = JSON.parse(raw) } catch { return }
    if (!String(event.type || '').startsWith('network.')) return
    if (event.type === 'network.presence') {
      for (const connection of state.connections) if (connection.counterpart?.beamId === event.beamId) connection.online = event.online
      for (const conversation of state.conversations) {
        for (const member of conversation.members) if (member.beamId === event.beamId) member.online = event.online
        conversation.online = conversation.kind === 'direct'
          ? Boolean(conversation.counterpart?.beamId === event.beamId ? event.online : conversation.online)
          : conversation.members.some((member) => member.beamId !== state.me.identity.beamId && member.online)
      }
      renderConnections()
      renderConversations()
      renderActiveConversation()
      return
    }
    if (event.type === 'network.message.created' && event.message?.encrypted) {
      try { event.message = await decryptMessage(event.message) } catch { event.message = { ...event.message, body: 'Unable to decrypt this message.', attachment: null, decryptionFailed: true } }
    }
    const isIncomingMessage = event.type === 'network.message.created' && event.message?.senderBeamId !== state.me.identity.beamId
    if (event.type === 'network.message.created' && event.conversationId === state.activeConversationId) {
      if (!state.messages.some((message) => message.messageId === event.message.messageId)) state.messages.push(event.message)
      renderMessages()
      markConversationRead(event.conversationId).catch(() => {})
    }
    refreshConversations().catch(() => {})
    if (event.type === 'network.connection.updated' || event.type === 'network.device.updated') refreshNetwork().catch(() => {})
    if (isIncomingMessage && event.conversationId !== state.activeConversationId) showForegroundNotification(event)
  }

  async function markConversationRead(conversationId) {
    const body = await signMutation({ type: 'network.conversation.read', conversationId, actorBeamId: state.me.identity.beamId })
    await api(`/network/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST', body: JSON.stringify(body) })
  }

  function showForegroundNotification(event) {
    if (document.visibilityState === 'visible' || window.Notification?.permission !== 'granted') return
    const conversation = state.conversations.find((item) => item.conversationId === event.conversationId)
    const notification = new Notification(conversation?.title || 'New Beam message', {
      body: event.message?.body || (event.message?.type === 'audio' ? 'Audio message' : event.message?.attachment ? 'Shared a file' : 'New encrypted message'),
      tag: `beam-conversation-${event.conversationId}`,
      icon: '/favicon.ico',
    })
    notification.onclick = () => { window.focus(); openConversation(event.conversationId).catch(() => {}) }
  }

  function urlBase64ToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4)
    return base64ToBytes((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
  }

  async function enableNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) throw new Error('Notifications are not supported in this browser.')
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') throw new Error('Notification permission was not granted.')
    const registration = await navigator.serviceWorker.register('/beam-network-sw.js', { scope: '/' })
    const config = await api('/network/notifications/config')
    if (!config.enabled || !config.publicKey) {
      setText('notification-status', 'FOREGROUND')
      elements.enableNotifications.textContent = 'Foreground alerts enabled'
      toast('Foreground alerts are ready. Add VAPID keys on the server for background push.')
      return
    }
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(config.publicKey) })
    const json = subscription.toJSON()
    const body = await signMutation({
      type: 'network.notification.subscribe', actorBeamId: state.me.identity.beamId, deviceId: getDeviceId(true),
      endpoint: subscription.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
    })
    await api('/network/notifications/subscriptions', { method: 'POST', body: JSON.stringify(body) })
    setText('notification-status', 'ON')
    elements.enableNotifications.textContent = 'Notifications enabled ✓'
    toast('Background notifications are enabled on this device.')
  }

  async function refreshNotificationUi() {
    if (!window.Notification) return
    const granted = Notification.permission === 'granted'
    setText('notification-status', granted ? 'ON' : 'OFF')
    if (granted) elements.enableNotifications.textContent = 'Notifications enabled ✓'
  }

  async function refreshDeviceVaultUi() {
    state.vaultMetadata = null
    if (isDeviceVaultCapable()) {
      try { state.vaultMetadata = await getDeviceVaultMetadata() } catch { state.vaultMetadata = null }
    }
    const hasVault = Boolean(state.vaultMetadata)
    elements.deviceUnlock.hidden = !hasVault
    elements.vaultDivider.hidden = !hasVault
    setText('device-unlock-beam-id', hasVault ? state.vaultMetadata.beamId : '')
    if (!isDeviceVaultCapable()) {
      elements.deviceVaultAction.disabled = true
      elements.deviceVaultAction.textContent = 'Passkeys unavailable'
      setText('device-vault-status', 'Use your recovery kit on this browser.')
    } else if (hasVault) {
      elements.deviceVaultAction.disabled = false
      elements.deviceVaultAction.textContent = 'Forget passkey vault →'
      setText('device-vault-status', `Ready for ${state.vaultMetadata.beamId}.`)
    } else {
      elements.deviceVaultAction.disabled = !state.kit
      elements.deviceVaultAction.textContent = 'Enable passkey →'
      setText('device-vault-status', 'Protect an encrypted copy on this device.')
    }
  }

  async function toggleDeviceVault() {
    if (state.vaultMetadata) {
      if (!window.confirm('Forget the encrypted Beam vault on this device?')) return
      await forgetDeviceVault()
      toast('Passkey vault removed from this browser.')
    } else {
      if (!state.kit) throw new Error('Open your Beam first.')
      await enrollDeviceVault(state.kit)
      toast('This device can now open Beam with its passkey.')
    }
    await refreshDeviceVaultUi()
  }

  async function openKit(kit, options = {}) {
    showUnlockError('')
    showLoading(true, 'Verifying your identity…')
    try {
      validateKit(kit)
      const privateKey = await importAndVerifyKeys(kit)
      state.kit = kit
      state.privateKey = privateKey
      state.encryptionPrivateKey = await ensureEncryptionIdentity(kit)
      await reconcileDirectoryEncryptionKey(kit)
      await refreshNetwork()
      if (state.me.identity.beamId !== kit.beamId) throw new Error('This credential belongs to another Beam ID.')
      await registerDevice()
      await refreshNetwork()
      elements.unlock.hidden = true
      elements.app.hidden = false
      window.history.replaceState(null, '', '/network')
      await Promise.all([refreshDeviceVaultUi(), refreshNotificationUi()])
      connectRealtime().catch(() => {})
      toast(options.deviceUnlock ? `Opened securely for ${state.me.identity.displayName}.` : `Welcome, ${state.me.identity.displayName}.`)
    } catch (error) {
      state.kit = null
      state.privateKey = null
      state.encryptionPrivateKey = null
      state.me = null
      showUnlockError(error.message || 'Beam could not open this recovery kit.')
      elements.unlock.hidden = false
      elements.app.hidden = true
    } finally { showLoading(false) }
  }

  async function openFile(file) {
    if (!file) return
    if (file.size > 128 * 1024) return showUnlockError('This file is too large to be a Beam recovery kit.')
    try { await openKit(JSON.parse(await file.text())) } catch (error) { showUnlockError(error instanceof SyntaxError ? 'This is not a valid recovery kit.' : error.message) }
  }

  async function closeSession() {
    if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer)
    if (state.socket) { state.socket.onclose = null; state.socket.close() }
    state.recordingStream?.getTracks().forEach((track) => track.stop())
    for (const url of state.objectUrls) URL.revokeObjectURL(url)
    Object.assign(state, { kit: null, privateKey: null, encryptionPrivateKey: null, me: null, connections: [], conversations: [], messages: [], devices: [], activeConversationId: null, pendingAttachment: null, socket: null })
    elements.kitInput.value = ''
    elements.app.hidden = true
    elements.unlock.hidden = false
    elements.app.classList.remove('has-active-chat')
    await refreshDeviceVaultUi()
  }

  function showActionError(error) {
    toast(error?.message || 'Beam could not complete this action.', true)
  }

  elements.kitInput.addEventListener('change', () => openFile(elements.kitInput.files?.[0]))
  for (const eventName of ['dragenter', 'dragover']) elements.kitDrop.addEventListener(eventName, (event) => { event.preventDefault(); elements.kitDrop.classList.add('is-dragging') })
  for (const eventName of ['dragleave', 'drop']) elements.kitDrop.addEventListener(eventName, (event) => { event.preventDefault(); elements.kitDrop.classList.remove('is-dragging') })
  elements.kitDrop.addEventListener('drop', (event) => openFile(event.dataTransfer?.files?.[0]))
  elements.deviceUnlock.addEventListener('click', async () => {
    elements.deviceUnlock.disabled = true
    try { await openKit(await unlockDeviceVault(), { deviceUnlock: true }) } catch (error) { showUnlockError(error.message) } finally { elements.deviceUnlock.disabled = false }
  })
  elements.identityMenu.addEventListener('click', () => closeSession().catch(showActionError))
  document.querySelectorAll('[data-rail-view]').forEach((button) => button.addEventListener('click', () => showRailView(button.dataset.railView)))
  document.querySelectorAll('[data-open-contacts]').forEach((button) => button.addEventListener('click', () => showRailView('contacts')))
  document.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', () => refreshNetwork().then(() => toast('Network refreshed.')).catch(showActionError)))
  elements.searchForm.addEventListener('submit', (event) => { event.preventDefault(); runSearch().catch(showActionError) })
  elements.globalSearch.addEventListener('input', renderConversations)
  elements.globalSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && elements.globalSearch.value.trim().length >= 3) {
      showRailView('contacts')
      elements.searchQuery.value = elements.globalSearch.value.trim()
      runSearch(elements.globalSearch.value).catch(showActionError)
    }
  })
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); elements.globalSearch.focus() }
  })
  elements.newGroup.addEventListener('click', () => elements.groupDialog.showModal())
  elements.groupForm.addEventListener('submit', (event) => {
    const submitter = event.submitter
    if (submitter?.value === 'cancel') return
    event.preventDefault()
    createGroup().catch(showActionError)
  })
  elements.messageForm.addEventListener('submit', (event) => { event.preventDefault(); sendMessage().catch(showActionError) })
  elements.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage().catch(showActionError) }
  })
  elements.messageInput.addEventListener('input', () => {
    elements.messageInput.style.height = 'auto'
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 126)}px`
  })
  elements.attachmentInput.addEventListener('change', async () => {
    try { state.pendingAttachment = await fileToAttachment(elements.attachmentInput.files?.[0]); renderAttachmentPreview() } catch (error) { showActionError(error); clearPendingAttachment() }
  })
  elements.clearAttachment.addEventListener('click', clearPendingAttachment)
  elements.recordAudio.addEventListener('click', () => startOrStopRecording().catch(showActionError))
  elements.backToList.addEventListener('click', () => elements.app.classList.remove('has-active-chat'))
  elements.detailsToggle.addEventListener('click', () => elements.detailPane.classList.toggle('is-open'))
  elements.detailClose.addEventListener('click', () => elements.detailPane.classList.remove('is-open'))
  elements.openSettings.addEventListener('click', () => elements.detailPane.classList.add('is-open'))
  elements.deviceVaultAction.addEventListener('click', () => toggleDeviceVault().catch(showActionError))
  elements.enableNotifications.addEventListener('click', () => enableNotifications().catch(showActionError))

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.opener || event.data?.type !== 'beam.identity.handoff') return
    openKit(event.data.recoveryKit, { freshClaim: true })
  })
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type !== 'beam.notification.open' || !state.kit || !event.data.conversationId) return
    openConversation(event.data.conversationId).catch(showActionError)
  })
  window.addEventListener('beforeunload', () => {
    state.recordingStream?.getTracks().forEach((track) => track.stop())
    for (const url of state.objectUrls) URL.revokeObjectURL(url)
  })

  refreshDeviceVaultUi().catch(() => {})
  if (window.opener && window.location.hash === '#handoff') window.opener.postMessage({ type: 'beam.network.ready' }, window.location.origin)
})()
