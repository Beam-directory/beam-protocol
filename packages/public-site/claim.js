import {
  enrollDeviceVault,
  getDeviceVaultMetadata,
  isDeviceVaultCapable,
} from './device-vault.js'
import { generateNetworkEncryptionIdentity } from './network-crypto.js'

;(function () {
  const API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3100'
    : 'https://api.beam.directory'
  const form = document.getElementById('claim-form')
  const formError = document.getElementById('form-error')
  const confirmError = document.getElementById('confirm-error')
  const completeButton = document.getElementById('complete-claim')
  const recoveryButton = document.getElementById('download-recovery')
  const openNetworkButton = document.getElementById('open-network')
  const loading = document.getElementById('claim-loading')
  const announcer = document.getElementById('claim-announcer')
  const stateElements = Array.from(document.querySelectorAll('[data-state]'))
  const progressSteps = Array.from(document.querySelectorAll('[data-progress]'))

  let claimToken = ''
  let recoveryKit = null
  let deviceVaultReady = false
  let stateTransitionTimer = 0

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
    const previousState = document.body.dataset.claimState || ''
    document.body.dataset.claimState = name
    if (previousState && previousState !== name) {
      document.body.dataset.previousClaimState = previousState
      document.body.classList.remove('is-state-changing')
      void document.body.offsetWidth
      document.body.classList.add('is-state-changing')
      window.clearTimeout(stateTransitionTimer)
      stateTransitionTimer = window.setTimeout(() => {
        document.body.classList.remove('is-state-changing')
      }, 760)
    }
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

    const [publicKey, privateKey, encryption] = await Promise.all([
      window.crypto.subtle.exportKey('spki', keyPair.publicKey),
      window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
      generateNetworkEncryptionIdentity(),
    ])

    return {
      publicKey: bufferToBase64(publicKey),
      privateKey: bufferToBase64(privateKey),
      encryption,
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
        encryption: deviceIdentity.encryption,
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

  function openNetwork() {
    if (!recoveryKit || !openNetworkButton) return
    const networkWindow = window.open('/network#handoff', '_blank')
    if (!networkWindow) {
      announce('Allow this site to open your Beam network, then try again.')
      return
    }

    openNetworkButton.disabled = true
    openNetworkButton.querySelector('span').textContent = 'Opening…'
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', handoff)
      openNetworkButton.disabled = false
      openNetworkButton.querySelector('span').textContent = 'Open my Beam'
    }, 10000)

    function handoff(event) {
      if (
        event.origin !== window.location.origin
        || event.source !== networkWindow
        || !event.data
        || event.data.type !== 'beam.network.ready'
      ) return

      networkWindow.postMessage({
        type: 'beam.identity.handoff',
        recoveryKit,
      }, window.location.origin)
      window.clearTimeout(timeout)
      window.removeEventListener('message', handoff)
      openNetworkButton.disabled = false
      openNetworkButton.querySelector('span').textContent = 'Open my Beam'
      announce('Your Beam network opened in a new tab.')
    }

    window.addEventListener('message', handoff)
  }

  async function protectOnThisDevice() {
    if (!recoveryKit || !isDeviceVaultCapable()) return false
    try {
      const existing = await getDeviceVaultMetadata()
      if (existing?.beamId === recoveryKit.beamId) return true
      if (existing) return false
      await enrollDeviceVault(recoveryKit)
      return true
    } catch {
      return false
    }
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
          body: JSON.stringify({
            token: claimToken,
            publicKey: deviceIdentity.publicKey,
            dhPublicKey: deviceIdentity.encryption.publicKey,
          }),
        })
        claimToken = ''
        recoveryKit = buildRecoveryKit(result, deviceIdentity)

        deviceVaultReady = await protectOnThisDevice()

        document.getElementById('claimed-beam-id').textContent = result.identity.beam_id
        document.getElementById('claimed-did').textContent = result.identity.did
        const securityCopy = document.getElementById('completion-security')
        if (securityCopy) {
          securityCopy.textContent = deviceVaultReady
            ? 'Protected by your passkey on this device. Exporting a recovery kit is optional.'
            : 'This browser could not create a passkey vault. Open Beam now, then export a recovery kit or enable a passkey in Settings.'
        }
        showState('complete')
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
  if (openNetworkButton) openNetworkButton.addEventListener('click', openNetwork)

  function processClaimFragment() {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const fragmentToken = fragment.get('token') || ''
    if (!fragmentToken) return false
    window.history.replaceState(null, '', `${window.location.pathname}#claim`)
    inspectClaim(fragmentToken)
    return true
  }

  function initClaimField() {
    const canvas = document.getElementById('claim-field-canvas')
    const shell = document.querySelector('.claim-shell')
    const panel = document.querySelector('.claim-panel')
    if (!canvas || !shell) return

    const context = canvas.getContext('2d')
    if (!context) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pointer = { x: .7, y: .5, active: false }
    const nodes = []
    let width = 0
    let height = 0
    let pixelRatio = 1
    let animationFrame = 0
    let visible = !document.hidden

    const stateTargets = {
      start: [.68, .54],
      email: [.66, .5],
      confirm: [.72, .5],
      complete: [.72, .46],
      invalid: [.68, .5],
    }

    function seeded(index, offset) {
      const value = Math.sin((index + 1) * 12.9898 + offset * 78.233) * 43758.5453
      return value - Math.floor(value)
    }

    function rebuild() {
      window.cancelAnimationFrame(animationFrame)
      const bounds = shell.getBoundingClientRect()
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75)
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

      const count = Math.max(16, Math.min(48, Math.round((width * height) / 42000)))
      nodes.length = 0
      for (let index = 0; index < count; index += 1) {
        nodes.push({
          x: seeded(index, 1),
          y: seeded(index, 2),
          drift: 7 + seeded(index, 3) * 16,
          phase: seeded(index, 4) * Math.PI * 2,
          speed: .35 + seeded(index, 5) * .55,
        })
      }

      draw(performance.now())
    }

    function position(node, seconds) {
      return {
        x: node.x * width + Math.sin(seconds * node.speed + node.phase) * node.drift,
        y: node.y * height + Math.cos(seconds * node.speed * .82 + node.phase) * node.drift,
      }
    }

    function draw(timestamp) {
      if (!width || !height) return
      const seconds = timestamp / 1000
      const state = document.body.dataset.claimState || 'start'
      const target = stateTargets[state] || stateTargets.start
      const compact = width < 980
      const anchorX = compact ? .5 : target[0]
      const anchorY = compact ? .58 : target[1]
      const influence = pointer.active ? .24 : 0
      const focusX = (anchorX * (1 - influence) + pointer.x * influence) * width
      const focusY = (anchorY * (1 - influence) + pointer.y * influence) * height
      const points = nodes.map((node) => position(node, reducedMotion.matches ? 0 : seconds))

      context.clearRect(0, 0, width, height)

      const atmosphere = context.createRadialGradient(focusX, focusY, 0, focusX, focusY, Math.max(width, height) * .56)
      atmosphere.addColorStop(0, 'rgba(184,255,106,.075)')
      atmosphere.addColorStop(.42, 'rgba(98,245,204,.018)')
      atmosphere.addColorStop(1, 'rgba(4,8,6,0)')
      context.fillStyle = atmosphere
      context.fillRect(0, 0, width, height)

      const linkDistance = Math.min(230, Math.max(130, width * .13))
      for (let first = 0; first < points.length; first += 1) {
        for (let second = first + 1; second < points.length; second += 1) {
          const dx = points[first].x - points[second].x
          const dy = points[first].y - points[second].y
          const distance = Math.hypot(dx, dy)
          if (distance > linkDistance) continue
          const alpha = (1 - distance / linkDistance) * .075
          context.strokeStyle = `rgba(184,255,106,${alpha})`
          context.lineWidth = .7
          context.beginPath()
          context.moveTo(points[first].x, points[first].y)
          context.lineTo(points[second].x, points[second].y)
          context.stroke()
        }
      }

      const closest = points
        .map((point, index) => ({ point, index, distance: Math.hypot(point.x - focusX, point.y - focusY) }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, compact ? 4 : 7)

      for (const connection of closest) {
        const beam = context.createLinearGradient(connection.point.x, connection.point.y, focusX, focusY)
        beam.addColorStop(0, 'rgba(184,255,106,.025)')
        beam.addColorStop(1, 'rgba(184,255,106,.27)')
        context.strokeStyle = beam
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(connection.point.x, connection.point.y)
        context.lineTo(focusX, focusY)
        context.stroke()
      }

      points.forEach((point, index) => {
        const pulse = reducedMotion.matches ? 0 : (Math.sin(seconds * 1.8 + nodes[index].phase) + 1) * .5
        context.fillStyle = `rgba(184,255,106,${.12 + pulse * .24})`
        context.beginPath()
        context.arc(point.x, point.y, 1 + pulse * 1.2, 0, Math.PI * 2)
        context.fill()
      })

      const focusPulse = reducedMotion.matches ? 0 : (Math.sin(seconds * 2.2) + 1) * 2.5
      context.strokeStyle = 'rgba(184,255,106,.22)'
      context.lineWidth = 1
      context.beginPath()
      context.arc(focusX, focusY, 11 + focusPulse, 0, Math.PI * 2)
      context.stroke()
      context.fillStyle = 'rgba(184,255,106,.92)'
      context.beginPath()
      context.arc(focusX, focusY, 2.2, 0, Math.PI * 2)
      context.fill()

      if (!reducedMotion.matches && visible) animationFrame = window.requestAnimationFrame(draw)
    }

    function updatePointer(event) {
      const bounds = shell.getBoundingClientRect()
      pointer.x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
      pointer.y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
      pointer.active = event.pointerType !== 'touch'
      shell.style.setProperty('--pointer-x', `${pointer.x * 100}%`)
      shell.style.setProperty('--pointer-y', `${pointer.y * 100}%`)
      shell.style.setProperty('--tilt-x', `${((.5 - pointer.y) * 3.2).toFixed(2)}deg`)
      shell.style.setProperty('--tilt-y', `${((pointer.x - .5) * 4.2).toFixed(2)}deg`)
    }

    shell.addEventListener('pointermove', updatePointer, { passive: true })
    shell.addEventListener('pointerleave', () => {
      pointer.active = false
      shell.style.setProperty('--tilt-x', '0deg')
      shell.style.setProperty('--tilt-y', '0deg')
    })

    panel?.querySelectorAll('.claim-submit, .identity-preview, .claimed-identity').forEach((element) => {
      element.addEventListener('pointermove', (event) => {
        const bounds = element.getBoundingClientRect()
        element.style.setProperty('--hot-x', `${event.clientX - bounds.left}px`)
        element.style.setProperty('--hot-y', `${event.clientY - bounds.top}px`)
      }, { passive: true })
    })

    const resizeObserver = new ResizeObserver(rebuild)
    resizeObserver.observe(shell)
    reducedMotion.addEventListener('change', rebuild)
    document.addEventListener('visibilitychange', () => {
      visible = !document.hidden
      window.cancelAnimationFrame(animationFrame)
      if (visible) draw(performance.now())
    })
    rebuild()
  }

  window.addEventListener('hashchange', processClaimFragment)
  if (!processClaimFragment()) showState('start')
  initClaimField()
})()
