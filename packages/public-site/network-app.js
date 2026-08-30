import {
  enrollDeviceVault,
  forgetDeviceVault,
  getDeviceVaultMetadata,
  isDeviceVaultCapable,
  unlockDeviceVault,
} from './device-vault.js'

;(function () {
  const API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3100'
    : 'https://api.beam.directory'

  const elements = {
    unlock: document.getElementById('unlock-shell'),
    app: document.getElementById('network-app'),
    loading: document.getElementById('app-loading'),
    unlockError: document.getElementById('unlock-error'),
    kitInput: document.getElementById('kit-input'),
    kitDrop: document.getElementById('kit-drop'),
    deviceUnlock: document.getElementById('device-unlock'),
    deviceUnlockBeamId: document.getElementById('device-unlock-beam-id'),
    vaultDivider: document.getElementById('vault-divider'),
    deviceSetup: document.getElementById('device-setup'),
    enableDeviceVault: document.getElementById('enable-device-vault'),
    deviceVaultStatus: document.getElementById('device-vault-status'),
    deviceVaultAction: document.getElementById('device-vault-action'),
    toast: document.getElementById('toast'),
    identityMenu: document.getElementById('identity-menu'),
    searchForm: document.getElementById('beam-search'),
    searchQuery: document.getElementById('search-query'),
    searchResults: document.getElementById('search-results'),
    searchList: document.getElementById('search-list'),
    closeSearch: document.getElementById('close-search'),
    connectionsList: document.getElementById('connections-list'),
    inboundList: document.getElementById('inbound-list'),
    outboundList: document.getElementById('outbound-list'),
  }

  const state = {
    kit: null,
    privateKey: null,
    me: null,
    connections: [],
    vaultMetadata: null,
    vaultCapable: false,
    toastTimer: null,
  }

  function setText(id, value) {
    const element = document.getElementById(id)
    if (element) element.textContent = String(value ?? '')
  }

  function initials(name) {
    return String(name || 'Beam')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
  }

  function kindLabel(kind) {
    if (kind === 'person') return 'PERSON'
    if (kind === 'organization') return 'COMPANY'
    if (kind === 'service') return 'SERVICE'
    return 'AGENT'
  }

  function showLoading(show, message) {
    if (!elements.loading) return
    const copy = elements.loading.querySelector('p')
    if (copy && message) copy.textContent = message
    elements.loading.hidden = !show
  }

  function showUnlockError(message) {
    if (!elements.unlockError) return
    elements.unlockError.textContent = message || ''
    elements.unlockError.hidden = !message
  }

  function toast(message, error) {
    if (!elements.toast) return
    if (state.toastTimer) window.clearTimeout(state.toastTimer)
    elements.toast.textContent = message
    elements.toast.classList.toggle('is-error', Boolean(error))
    elements.toast.hidden = false
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true
    }, 4200)
  }

  async function refreshDeviceVaultUi() {
    state.vaultCapable = isDeviceVaultCapable()
    state.vaultMetadata = null

    if (state.vaultCapable) {
      try {
        state.vaultMetadata = await getDeviceVaultMetadata()
      } catch (error) {
        if (!state.kit) showUnlockError(error.message || 'The saved Beam device vault is unavailable.')
      }
    }

    const hasVault = Boolean(state.vaultMetadata)
    if (elements.deviceUnlock) elements.deviceUnlock.hidden = !hasVault
    if (elements.vaultDivider) elements.vaultDivider.hidden = !hasVault
    if (elements.deviceUnlockBeamId) {
      elements.deviceUnlockBeamId.textContent = hasVault ? state.vaultMetadata.beamId : ''
    }
    if (elements.deviceSetup) {
      elements.deviceSetup.hidden = !state.kit || !state.vaultCapable || hasVault
    }

    if (elements.deviceVaultAction && elements.deviceVaultStatus) {
      elements.deviceVaultAction.classList.toggle('is-forget', hasVault)
      if (!state.vaultCapable) {
        elements.deviceVaultStatus.textContent = 'This browser does not support an encrypted passkey vault. Keep using your recovery kit.'
        elements.deviceVaultAction.textContent = 'Unavailable'
        elements.deviceVaultAction.disabled = true
      } else if (hasVault) {
        const currentIdentity = state.me && state.me.identity && state.me.identity.beamId
        const matchesCurrentIdentity = !currentIdentity || currentIdentity === state.vaultMetadata.beamId
        elements.deviceVaultStatus.textContent = matchesCurrentIdentity
          ? `Ready for ${state.vaultMetadata.beamId}. Your encrypted vault opens only after device confirmation.`
          : `This device currently opens ${state.vaultMetadata.beamId}. Forget it before saving another Beam.`
        elements.deviceVaultAction.textContent = 'Forget this device'
        elements.deviceVaultAction.disabled = false
      } else {
        elements.deviceVaultStatus.textContent = 'Use a passkey to keep an encrypted Beam vault on this device.'
        elements.deviceVaultAction.textContent = 'Enable passkey'
        elements.deviceVaultAction.disabled = !state.kit
      }
    }
  }

  async function enableVault(button) {
    if (!state.kit) throw new Error('Open your Beam before enabling this device.')
    if (state.vaultMetadata) throw new Error('Forget the existing device vault before saving another Beam.')
    button.disabled = true
    try {
      showLoading(true, 'Protecting this device…')
      await enrollDeviceVault(state.kit)
      await refreshDeviceVaultUi()
      toast('This device can now open your Beam with a passkey.')
    } finally {
      showLoading(false)
      button.disabled = false
    }
  }

  async function forgetVault(button) {
    const confirmed = window.confirm('Forget the encrypted Beam vault on this device? You will need your recovery kit next time.')
    if (!confirmed) return
    button.disabled = true
    try {
      await forgetDeviceVault()
      await refreshDeviceVaultUi()
      toast('This device no longer keeps an encrypted Beam vault.')
    } finally {
      button.disabled = false
    }
  }

  async function unlockWithDevice() {
    if (!elements.deviceUnlock) return
    elements.deviceUnlock.disabled = true
    showUnlockError('')
    showLoading(true, 'Confirming this device…')
    try {
      const kit = await unlockDeviceVault()
      await openKit(kit, { deviceUnlock: true })
    } catch (error) {
      showUnlockError(error.message || 'This device could not open your Beam.')
    } finally {
      showLoading(false)
      elements.deviceUnlock.disabled = false
    }
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
    for (const byte of bytes) binary += String.fromCharCode(byte)
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

  async function api(path, options) {
    if (!state.kit || !state.kit.credential || !state.kit.credential.apiKey) {
      throw new Error('Open your recovery kit first.')
    }
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${state.kit.credential.apiKey}`,
        ...(options && options.body ? { 'content-type': 'application/json' } : {}),
        ...(options && options.headers ? options.headers : {}),
      },
    })
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      payload = {}
    }
    if (!response.ok) {
      const error = new Error(payload.error || 'Beam could not complete this request.')
      error.code = payload.errorCode || 'REQUEST_FAILED'
      error.status = response.status
      throw error
    }
    return payload
  }

  function validateKit(kit) {
    const valid = kit
      && typeof kit === 'object'
      && kit.format === 'beam-identity-recovery'
      && kit.version === 1
      && typeof kit.beamId === 'string'
      && kit.beamId.endsWith('.directory')
      && kit.identity
      && kit.identity.algorithm === 'Ed25519'
      && typeof kit.identity.publicKey === 'string'
      && typeof kit.identity.privateKey === 'string'
      && kit.credential
      && typeof kit.credential.apiKey === 'string'
      && kit.credential.apiKey.startsWith('bk_')
    if (!valid) throw new Error('This is not a valid Beam recovery kit.')
  }

  async function importAndVerifyKeys(kit) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('This browser cannot open a secure Beam identity.')
    }
    try {
      const [privateKey, publicKey] = await Promise.all([
        window.crypto.subtle.importKey(
          'pkcs8',
          base64ToBytes(kit.identity.privateKey),
          { name: 'Ed25519' },
          false,
          ['sign'],
        ),
        window.crypto.subtle.importKey(
          'spki',
          base64ToBytes(kit.identity.publicKey),
          { name: 'Ed25519' },
          false,
          ['verify'],
        ),
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

  async function signMutation(payload) {
    if (!state.privateKey) throw new Error('Your private identity key is not open.')
    const signed = {
      ...payload,
      timestamp: new Date().toISOString(),
      nonce: createNonce(),
    }
    const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(signed)))
    const signature = await window.crypto.subtle.sign('Ed25519', state.privateKey, encoded)
    return { ...signed, signature: bytesToBase64(signature) }
  }

  function showView(name) {
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== name
    })
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === name)
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function emptyState(title, detail, symbol) {
    const wrapper = document.createElement('div')
    wrapper.className = 'empty-state'
    const content = document.createElement('div')
    const icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = symbol
    const heading = document.createElement('strong')
    heading.textContent = title
    const copy = document.createElement('small')
    copy.textContent = detail
    content.append(icon, heading, copy)
    wrapper.append(content)
    return wrapper
  }

  function actionButton(label, className, handler) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (className) button.className = className
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await handler()
      } catch (error) {
        toast(error.message || 'Beam could not complete this action.', true)
      } finally {
        button.disabled = false
      }
    })
    return button
  }

  function identityRow(profile, connection, context) {
    const row = document.createElement('article')
    row.className = 'identity-row'

    const avatar = document.createElement('span')
    avatar.className = 'row-avatar'
    avatar.textContent = initials(profile.displayName)

    const main = document.createElement('div')
    main.className = 'identity-main'
    const name = document.createElement('strong')
    name.textContent = profile.displayName
    const beamId = document.createElement('small')
    beamId.textContent = profile.beamId
    main.append(name, beamId)

    const meta = document.createElement('div')
    meta.className = 'identity-meta'
    const kind = document.createElement('span')
    kind.textContent = kindLabel(profile.identityKind)
    const proof = document.createElement('span')
    proof.className = profile.assured ? 'is-verified' : ''
    proof.textContent = profile.assured ? `✓ ${String(profile.assurance).toUpperCase()}` : 'UNVERIFIED'
    meta.append(kind, proof)

    const actions = document.createElement('div')
    actions.className = 'row-actions'

    if (context === 'search') {
      if (!profile.assured) {
        const status = document.createElement('span')
        status.className = 'row-status'
        status.textContent = 'NOT VERIFIED'
        actions.append(status)
      } else if (!connection || connection.status === 'declined' || connection.status === 'cancelled') {
        actions.append(actionButton('Connect', 'primary-action', () => requestConnection(profile.beamId)))
      } else {
        const status = document.createElement('span')
        status.className = 'row-status'
        status.textContent = connection.status === 'accepted'
          ? '✓ CONNECTED'
          : connection.status === 'blocked'
            ? 'BLOCKED'
            : connection.direction === 'inbound' ? 'REQUEST RECEIVED' : 'REQUEST SENT'
        actions.append(status)
      }
    } else if (connection.status === 'accepted') {
      actions.append(actionButton('Remove', 'danger-action', () => removeConnection(connection.connectionId)))
    } else if (connection.status === 'pending' && connection.direction === 'inbound') {
      actions.append(
        actionButton('Accept', 'primary-action', () => respondConnection(connection.connectionId, 'accepted')),
        actionButton('Decline', '', () => respondConnection(connection.connectionId, 'declined')),
        actionButton('Block', 'danger-action', () => respondConnection(connection.connectionId, 'blocked')),
      )
    } else if (connection.status === 'pending') {
      actions.append(actionButton('Cancel', 'danger-action', () => removeConnection(connection.connectionId)))
    }

    row.append(avatar, main, meta, actions)
    return row
  }

  function renderList(container, items, emptyCopy, context) {
    if (!container) return
    container.replaceChildren()
    if (items.length === 0) {
      container.append(emptyState(emptyCopy.title, emptyCopy.detail, emptyCopy.symbol))
      return
    }
    for (const item of items) {
      const profile = context === 'search' ? item.identity : item.counterpart
      const connection = context === 'search' ? item.connection : item
      if (profile) container.append(identityRow(profile, connection, context))
    }
  }

  function renderApp() {
    if (!state.me) return
    const identity = state.me.identity
    const contacts = state.connections.filter((connection) => connection.status === 'accepted')
    const inbound = state.connections.filter((connection) => connection.status === 'pending' && connection.direction === 'inbound')
    const outbound = state.connections.filter((connection) => connection.status === 'pending' && connection.direction === 'outbound')

    setText('header-avatar', initials(identity.displayName))
    setText('header-name', identity.displayName)
    setText('header-beam-id', identity.beamId)
    setText('contacts-count', contacts.length)
    setText('requests-count', inbound.length)
    setText('stat-contacts', contacts.length)
    setText('stat-pending', inbound.length + outbound.length)
    setText('inbound-count', inbound.length)
    setText('outbound-count', outbound.length)
    setText('profile-avatar', initials(identity.displayName))
    setText('profile-name', identity.displayName)
    setText('profile-beam-id', identity.beamId)
    setText('profile-did', identity.did)
    setText('profile-kind', kindLabel(identity.identityKind))

    renderList(elements.connectionsList, contacts, {
      title: 'Your network starts with one trusted connection.',
      detail: 'Search an exact Beam ID above and send a signed request. They decide whether it becomes mutual.',
      symbol: '+',
    }, 'connection')
    renderList(elements.inboundList, inbound, {
      title: 'Nothing waiting.',
      detail: 'New requests appear here. You accept, decline, or block each one.',
      symbol: '↘',
    }, 'connection')
    renderList(elements.outboundList, outbound, {
      title: 'No open requests.',
      detail: 'Requests you send remain visible until the other identity responds.',
      symbol: '↗',
    }, 'connection')
  }

  async function refreshNetwork() {
    const [me, connectionResult] = await Promise.all([
      api('/network/me'),
      api('/network/connections'),
    ])
    state.me = me
    state.connections = connectionResult.connections || []
    renderApp()
  }

  async function requestConnection(recipientBeamId) {
    const body = await signMutation({
      type: 'network.connection.request',
      requesterBeamId: state.me.identity.beamId,
      recipientBeamId,
      message: '',
    })
    await api('/network/connections', { method: 'POST', body: JSON.stringify(body) })
    await refreshNetwork()
    await runSearch()
    toast(`Connection request sent to ${recipientBeamId}.`)
  }

  async function respondConnection(connectionId, decision) {
    const body = await signMutation({
      type: 'network.connection.respond',
      connectionId,
      actorBeamId: state.me.identity.beamId,
      decision,
    })
    await api(`/network/connections/${encodeURIComponent(connectionId)}/respond`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await refreshNetwork()
    toast(decision === 'accepted' ? 'Connection confirmed.' : decision === 'blocked' ? 'Identity blocked.' : 'Request declined.')
  }

  async function removeConnection(connectionId) {
    const body = await signMutation({
      type: 'network.connection.remove',
      connectionId,
      actorBeamId: state.me.identity.beamId,
    })
    await api(`/network/connections/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    })
    await refreshNetwork()
    toast('Connection removed.')
  }

  async function runSearch() {
    const query = elements.searchQuery ? elements.searchQuery.value.trim() : ''
    if (query.length < 3) return
    const submit = elements.searchForm && elements.searchForm.querySelector('button[type="submit"]')
    if (submit) submit.disabled = true
    try {
      const result = await api(`/network/discover?q=${encodeURIComponent(query)}`)
      renderList(elements.searchList, result.results || [], {
        title: 'No identity found.',
        detail: 'Private identities require their complete Beam ID. Check the spelling and try again.',
        symbol: '⌕',
      }, 'search')
      if (elements.searchResults) elements.searchResults.hidden = false
    } finally {
      if (submit) submit.disabled = false
    }
  }

  async function openKit(kit, options) {
    showUnlockError('')
    showLoading(true, 'Verifying your identity…')
    try {
      validateKit(kit)
      const privateKey = await importAndVerifyKeys(kit)
      state.kit = kit
      state.privateKey = privateKey
      await refreshNetwork()
      if (state.me.identity.beamId !== kit.beamId) {
        throw new Error('This credential does not belong to the Beam ID in the recovery kit.')
      }
      if (elements.unlock) elements.unlock.hidden = true
      if (elements.app) elements.app.hidden = false
      window.history.replaceState(null, '', '/network')
      await refreshDeviceVaultUi()
      if (options && options.freshClaim && state.vaultCapable && !state.vaultMetadata) {
        toast('Beam is open. Enable a passkey once to make the next visit instant.')
      } else if (options && options.deviceUnlock) {
        toast(`Opened securely for ${state.me.identity.displayName}.`)
      } else {
        toast(`Welcome back, ${state.me.identity.displayName}.`)
      }
    } catch (error) {
      state.kit = null
      state.privateKey = null
      state.me = null
      state.connections = []
      showUnlockError(error.message || 'Beam could not open this recovery kit.')
      if (elements.unlock) elements.unlock.hidden = false
      if (elements.app) elements.app.hidden = true
    } finally {
      showLoading(false)
    }
  }

  async function openFile(file) {
    if (!file) return
    if (file.size > 128 * 1024) {
      showUnlockError('This file is too large to be a Beam recovery kit.')
      return
    }
    try {
      const text = await file.text()
      await openKit(JSON.parse(text))
    } catch (error) {
      showUnlockError(error instanceof SyntaxError
        ? 'This file is not a valid Beam recovery kit.'
        : error.message || 'Beam could not read this file.')
    }
  }

  async function closeSession() {
    state.kit = null
    state.privateKey = null
    state.me = null
    state.connections = []
    if (elements.kitInput) elements.kitInput.value = ''
    if (elements.app) elements.app.hidden = true
    if (elements.unlock) elements.unlock.hidden = false
    if (elements.searchResults) elements.searchResults.hidden = true
    showView('contacts')
    showUnlockError('')
    await refreshDeviceVaultUi()
  }

  if (elements.kitInput) {
    elements.kitInput.addEventListener('change', () => openFile(elements.kitInput.files && elements.kitInput.files[0]))
  }
  if (elements.kitDrop) {
    for (const eventName of ['dragenter', 'dragover']) {
      elements.kitDrop.addEventListener(eventName, (event) => {
        event.preventDefault()
        elements.kitDrop.classList.add('is-dragging')
      })
    }
    for (const eventName of ['dragleave', 'drop']) {
      elements.kitDrop.addEventListener(eventName, (event) => {
        event.preventDefault()
        elements.kitDrop.classList.remove('is-dragging')
      })
    }
    elements.kitDrop.addEventListener('drop', (event) => openFile(event.dataTransfer && event.dataTransfer.files[0]))
  }
  if (elements.identityMenu) {
    elements.identityMenu.addEventListener('click', () => {
      closeSession().catch(() => showUnlockError('Beam could not refresh this device state.'))
    })
  }
  if (elements.deviceUnlock) elements.deviceUnlock.addEventListener('click', unlockWithDevice)
  if (elements.enableDeviceVault) {
    elements.enableDeviceVault.addEventListener('click', async () => {
      try {
        await enableVault(elements.enableDeviceVault)
      } catch (error) {
        toast(error.message || 'Beam could not enable this device.', true)
      }
    })
  }
  if (elements.deviceVaultAction) {
    elements.deviceVaultAction.addEventListener('click', async () => {
      try {
        if (state.vaultMetadata) await forgetVault(elements.deviceVaultAction)
        else await enableVault(elements.deviceVaultAction)
      } catch (error) {
        toast(error.message || 'Beam could not update this device.', true)
      }
    })
  }
  if (elements.searchForm) {
    elements.searchForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      try {
        await runSearch()
      } catch (error) {
        toast(error.message || 'Beam search failed.', true)
      }
    })
  }
  if (elements.closeSearch) elements.closeSearch.addEventListener('click', () => { elements.searchResults.hidden = true })
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view))
  })
  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await refreshNetwork()
        if (elements.searchResults && !elements.searchResults.hidden) await runSearch()
        toast('Network refreshed.')
      } catch (error) {
        toast(error.message || 'Beam could not refresh.', true)
      } finally {
        button.disabled = false
      }
    })
  })

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.opener) return
    if (!event.data || event.data.type !== 'beam.identity.handoff') return
    openKit(event.data.recoveryKit, { freshClaim: true })
  })

  refreshDeviceVaultUi().catch((error) => {
    showUnlockError(error.message || 'Beam could not inspect this device.')
  })

  if (window.opener && window.location.hash === '#handoff') {
    window.opener.postMessage({ type: 'beam.network.ready' }, window.location.origin)
  }
})()
