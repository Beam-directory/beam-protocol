const API_URL = 'https://api.beam.directory/agents/register'

const state = {
  publicKeyBase64: '',
  privateKeyBase64: '',
  apiKey: '',
  beamId: '',
  did: '',
  verificationTier: '',
  downloaded: false,
}

const elements = {
  form: document.querySelector('#register-form'),
  displayName: document.querySelector('#display-name'),
  email: document.querySelector('#email'),
  generateButton: document.querySelector('#generate-button'),
  submitButton: document.querySelector('#submit-button'),
  downloadButton: document.querySelector('#download-button'),
  formStatus: document.querySelector('#form-status'),
  resultPanel: document.querySelector('#result-panel'),
  resultStatus: document.querySelector('#result-status'),
  beamIdValue: document.querySelector('#beam-id-value'),
  didValue: document.querySelector('#did-value'),
  tierValue: document.querySelector('#tier-value'),
  copyBeamIdButton: document.querySelector('#copy-beam-id-button'),
  testEchoButton: document.querySelector('#test-echo-button'),
  tsQuickstart: document.querySelector('#ts-quickstart'),
  pyQuickstart: document.querySelector('#py-quickstart'),
  publicKeyPreview: document.querySelector('#public-key-preview'),
  secretKeyPreview: document.querySelector('#secret-key-preview'),
}

function getTypeScriptQuickstart(beamId) {
  return [
    "import { readFileSync } from 'node:fs'",
    "import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'",
    "const bundle = JSON.parse(readFileSync('./beam-identity.json', 'utf8'))",
    "const identity = BeamIdentity.fromData(bundle)",
    "const client = new BeamClient({ identity: identity.export(), apiKey: bundle.apiKey, directoryUrl: 'https://api.beam.directory' })",
    `const reply = await client.talk('echo@beam.directory', 'Hello from ${beamId}')`,
    'console.log(reply.message)',
  ].join('\n')
}

function getPythonQuickstart(beamId) {
  return [
    'import json',
    'from beam_directory import BeamClient, BeamIdentity',
    "with open('beam-identity.json', 'r', encoding='utf-8') as fh:",
    "    bundle = json.load(fh)",
    "identity = BeamIdentity.from_data(bundle)",
    "client = BeamClient(identity=identity, api_key=bundle.get('apiKey'), directory_url='https://api.beam.directory')",
    `reply = await client.talk('echo@beam.directory', 'Hello from ${beamId}')`,
    'print(reply.message)',
  ].join('\n')
}

function getEchoCommand(beamId) {
  return `beam talk echo@beam.directory "Hello from ${beamId}"`
}

async function copyText(text, button, doneLabel) {
  await navigator.clipboard.writeText(text)
  if (!button) return
  const originalLabel = button.textContent
  button.textContent = doneLabel
  setTimeout(() => {
    button.textContent = originalLabel
  }, 1800)
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function getSelectedCapabilities() {
  return Array.from(document.querySelectorAll('input[name="capabilities"]:checked')).map((input) => input.value)
}

function setBusy(isBusy) {
  elements.generateButton.disabled = isBusy
  elements.submitButton.disabled = isBusy
  elements.submitButton.textContent = isBusy ? 'Registriere…' : 'Jetzt registrieren'
}

function clearStatus() {
  elements.formStatus.className = 'status'
  elements.formStatus.textContent = ''
}

function showStatus(message, type) {
  elements.formStatus.className = `status ${type}`
  elements.formStatus.textContent = message
}

function maskBase64(value) {
  if (!value) {
    return 'Noch kein Schlüssel erzeugt.'
  }

  if (value.length <= 44) {
    return value
  }

  return `${value.slice(0, 28)}…${value.slice(-16)}`
}

function updateKeyPreview() {
  elements.publicKeyPreview.textContent = state.publicKeyBase64 ? maskBase64(state.publicKeyBase64) : 'Noch kein Schlüssel erzeugt.'
  elements.secretKeyPreview.textContent = state.privateKeyBase64 ? 'Lokal erzeugt – wird aus Sicherheitsgründen nicht angezeigt.' : 'Wird lokal generiert und nie an die API gesendet.'
  elements.downloadButton.disabled = !(state.beamId && state.publicKeyBase64 && state.privateKeyBase64 && state.apiKey)
}

function updateResult(data) {
  state.beamId = data.beamId || data.beam_id || ''
  state.did = data.did || ''
  state.verificationTier = data.verificationTier || data.verification_tier || ''
  state.apiKey = typeof data.apiKey === 'string' ? data.apiKey : ''
  if (!state.apiKey) throw new Error('Die Directory API hat keinen einmaligen Agent-API-Schlüssel zurückgegeben.')

  elements.beamIdValue.textContent = state.beamId || '–'
  elements.didValue.textContent = state.did || '–'
  elements.tierValue.textContent = state.verificationTier || '–'
  elements.tsQuickstart.textContent = state.beamId ? getTypeScriptQuickstart(state.beamId) : 'Wird nach der Registrierung generiert.'
  elements.pyQuickstart.textContent = state.beamId ? getPythonQuickstart(state.beamId) : 'Wird nach der Registrierung generiert.'
  elements.resultStatus.textContent = 'Registrierung erfolgreich. Identity-Datei jetzt herunterladen.'
  elements.resultPanel.hidden = false
  elements.copyBeamIdButton.disabled = !state.beamId
  elements.testEchoButton.disabled = !state.beamId
  updateKeyPreview()
}

async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  state.publicKeyBase64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey)))
  state.privateKeyBase64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)))
  state.apiKey = ''
  state.downloaded = false
  updateKeyPreview()
  clearStatus()
}

function downloadIdentity() {
  if (!state.beamId || !state.publicKeyBase64 || !state.privateKeyBase64 || !state.apiKey) {
    showStatus('Registriere den Agenten zuerst, bevor du die Identity-Datei herunterlädst.', 'error')
    return
  }

  const payload = {
    format: 'beam-local-identity/v1',
    beamId: state.beamId,
    publicKey: state.publicKeyBase64,
    privateKey: state.privateKeyBase64,
    publicKeyBase64: state.publicKeyBase64,
    privateKeyBase64: state.privateKeyBase64,
    apiKey: state.apiKey,
    directoryUrl: 'https://api.beam.directory',
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'beam-identity.json'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  state.downloaded = true
}

async function submitRegistration(event) {
  event.preventDefault()
  clearStatus()

  if (!elements.form.reportValidity()) {
    return
  }

  if (!state.publicKeyBase64 || !state.privateKeyBase64) {
    await generateKeyPair()
  }

  const displayName = elements.displayName.value.trim()
  const email = elements.email.value.trim()
  const capabilities = getSelectedCapabilities()

  const body = {
    displayName,
    publicKey: state.publicKeyBase64,
    capabilities,
  }

  if (email) {
    body.email = email
  }

  setBusy(true)

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : 'Registrierung fehlgeschlagen.'
      throw new Error(message)
    }

    updateResult(data)
    showStatus('Agent erfolgreich bei beam.directory registriert.', 'success')
  } catch (error) {
    elements.resultPanel.hidden = true
    showStatus(error instanceof Error ? error.message : 'Unbekannter Fehler bei der Registrierung.', 'error')
  } finally {
    setBusy(false)
  }
}

elements.generateButton.addEventListener('click', async () => {
  try {
    await generateKeyPair()
    showStatus('Neues Ed25519-Keypair lokal erzeugt.', 'success')
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Schlüssel konnten nicht erzeugt werden.', 'error')
  }
})

elements.copyBeamIdButton.addEventListener('click', async () => {
  if (!state.beamId) return
  await copyText(state.beamId, elements.copyBeamIdButton, 'Kopiert!')
})

elements.testEchoButton.addEventListener('click', async () => {
  if (!state.beamId) return
  await copyText(getEchoCommand(state.beamId), elements.testEchoButton, 'Testkommando kopiert!')
  showStatus('Echo-Testkommando kopiert. Führe es in deinem Terminal aus.', 'success')
})

elements.downloadButton.addEventListener('click', downloadIdentity)
elements.form.addEventListener('submit', submitRegistration)

window.addEventListener('beforeunload', (event) => {
  if (!state.apiKey || state.downloaded) return
  event.preventDefault()
  event.returnValue = ''
})

updateKeyPreview()
