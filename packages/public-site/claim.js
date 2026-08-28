(function () {
  const API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3100'
    : 'https://api.beam.directory'
  const form = document.getElementById('claim-form')
  const formError = document.getElementById('form-error')
  const confirmError = document.getElementById('confirm-error')
  const completeButton = document.getElementById('complete-claim')
  const recoveryButton = document.getElementById('download-recovery')
  const loading = document.getElementById('claim-loading')
  const announcer = document.getElementById('claim-announcer')
  const stateElements = Array.from(document.querySelectorAll('[data-state]'))
  const progressSteps = Array.from(document.querySelectorAll('[data-progress]'))

  let claimToken = ''
  let recoveryKit = null

  function announce(message) {
    if (announcer) announcer.textContent = message
  }

  function setProgress(step) {
    for (const element of progressSteps) {
      const value = Number(element.dataset.progress)
      element.classList.toggle('is-active', value === step)
      element.classList.toggle('is-done', value < step)
      const marker = element.querySelector('i')
      if (marker) marker.textContent = value < step ? '✓' : String(value)
    }
  }

  function showState(name) {
    for (const element of stateElements) {
      element.hidden = element.dataset.state !== name
    }
    if (loading) loading.hidden = true
    setProgress(name === 'complete' ? 3 : name === 'email' || name === 'confirm' ? 2 : 1)
  }

  function showLoading(message) {
    if (!loading) return
    const text = loading.querySelector('p')
    if (text) text.textContent = message
    loading.hidden = false
  }

  function setError(element, message) {
    if (!element) return
    element.textContent = message
    element.hidden = !message
  }

  function cleanHandle(value) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 32)
  }

  async function api(path, options) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
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

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return window.btoa(binary)
  }

  async function createDeviceIdentity() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('This browser cannot create a secure identity key. Please use a current version of Safari, Chrome, Edge, or Firefox.')
    }

    let keyPair
    try {
      keyPair = await window.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    } catch {
      throw new Error('This browser does not support secure Beam identity keys yet. Please use a current version of Safari, Chrome, Edge, or Firefox.')
    }

    const [publicKey, privateKey] = await Promise.all([
      window.crypto.subtle.exportKey('spki', keyPair.publicKey),
      window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ])

    return {
      publicKey: bufferToBase64(publicKey),
      privateKey: bufferToBase64(privateKey),
    }
  }

  function buildRecoveryKit(result, deviceIdentity) {
    return {
      format: 'beam-identity-recovery',
      version: 1,
      createdAt: new Date().toISOString(),
      beamId: result.identity.beam_id,
      did: result.identity.did,
      directoryUrl: result.credential.directoryUrl,
      identity: {
        algorithm: 'Ed25519',
        publicKey: deviceIdentity.publicKey,
        privateKey: deviceIdentity.privateKey,
      },
      credential: {
        apiKey: result.credential.apiKey,
      },
      notice: 'Keep this file private. It controls your Beam identity and is not stored by Beam.',
    }
  }

  function downloadKit() {
    if (!recoveryKit) return
    const blob = new Blob([`${JSON.stringify(recoveryKit, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${recoveryKit.beamId.replace('@', '_at_')}-recovery.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    announce('Recovery kit download started.')
  }

  async function inspectClaim(token) {
    showLoading('Checking your Beam…')
    try {
      const claim = await api('/identity-claims/inspect', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      claimToken = token
      const beamId = document.getElementById('confirmed-beam-id')
      const email = document.getElementById('confirmed-email')
      if (beamId) beamId.textContent = claim.beamId
      if (email) email.textContent = claim.email
      showState('confirm')
      announce(`${claim.beamId} is ready to claim.`)
    } catch {
      showState('invalid')
      announce('This claim link is invalid or expired.')
    }
  }

  if (form) {
    const handleInput = form.elements.namedItem('handle')
    if (handleInput) {
      handleInput.addEventListener('input', () => {
        const cleaned = cleanHandle(handleInput.value)
        if (cleaned !== handleInput.value) handleInput.value = cleaned
      })
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      setError(formError, '')

      if (!form.reportValidity()) return
      const data = new FormData(form)
      const submit = form.querySelector('button[type="submit"]')
      const payload = {
        displayName: String(data.get('displayName') || '').trim(),
        handle: cleanHandle(String(data.get('handle') || '')),
        email: String(data.get('email') || '').trim().toLowerCase(),
      }

      submit.disabled = true
      submit.querySelector('span').textContent = 'Reserving…'

      try {
        const result = await api('/identity-claims', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const requestedBeamId = document.getElementById('requested-beam-id')
        if (requestedBeamId) requestedBeamId.textContent = result.beamId
        showState('email')
        announce(`Confirmation email sent for ${result.beamId}.`)
      } catch (error) {
        setError(formError, error.message || 'Beam could not reserve this name. Please try again.')
      } finally {
        submit.disabled = false
        submit.querySelector('span').textContent = 'Continue'
      }
    })
  }

  document.querySelectorAll('[data-action="restart"]').forEach((button) => {
    button.addEventListener('click', () => showState('start'))
  })

  if (completeButton) {
    completeButton.addEventListener('click', async () => {
      setError(confirmError, '')
      completeButton.disabled = true
      completeButton.querySelector('span').textContent = 'Creating securely…'

      try {
        const deviceIdentity = await createDeviceIdentity()
        const result = await api('/identity-claims/complete', {
          method: 'POST',
          body: JSON.stringify({ token: claimToken, publicKey: deviceIdentity.publicKey }),
        })
        claimToken = ''
        recoveryKit = buildRecoveryKit(result, deviceIdentity)

        document.getElementById('claimed-beam-id').textContent = result.identity.beam_id
        document.getElementById('claimed-did').textContent = result.identity.did
        showState('complete')
        downloadKit()
        announce(`${result.identity.beam_id} is now yours.`)
      } catch (error) {
        setError(confirmError, error.message || 'Beam could not finish this claim. Please try again.')
      } finally {
        completeButton.disabled = false
        completeButton.querySelector('span').textContent = 'Create my Beam'
      }
    })
  }

  if (recoveryButton) recoveryButton.addEventListener('click', downloadKit)

  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const fragmentToken = fragment.get('token') || ''
  if (fragmentToken) {
    window.history.replaceState(null, '', `${window.location.pathname}#claim`)
  }

  if (fragmentToken) inspectClaim(fragmentToken)
  else showState('start')
})()
