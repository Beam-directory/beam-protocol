const DB_NAME = 'beam-device-vault'
const DB_VERSION = 1
const STORE_NAME = 'vaults'
const PRIMARY_VAULT_ID = 'primary'
const MAX_VAULT_BYTES = 128 * 1024
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class DeviceVaultError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DeviceVaultError'
    this.code = code
  }
}

export function isDeviceVaultCapable() {
  return Boolean(
    window.isSecureContext
    && window.indexedDB
    && window.PublicKeyCredential
    && navigator.credentials
    && window.crypto
    && window.crypto.subtle,
  )
}

function randomBytes(length) {
  const bytes = new Uint8Array(length)
  window.crypto.getRandomValues(bytes)
  return bytes
}

function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlToBytes(value, maximumLength) {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value) || value.length > maximumLength) {
    throw new DeviceVaultError('The saved device vault is invalid.', 'INVALID_VAULT')
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=')
  try {
    const binary = window.atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new DeviceVaultError('The saved device vault is invalid.', 'INVALID_VAULT')
  }
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new DeviceVaultError('Beam could not open secure device storage.', 'STORAGE_UNAVAILABLE'))
    request.onblocked = () => reject(new DeviceVaultError('Close other Beam tabs and try again.', 'STORAGE_BLOCKED'))
  })
}

async function readVaultRecord() {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(PRIMARY_VAULT_ID)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => reject(new DeviceVaultError('Beam could not read secure device storage.', 'STORAGE_UNAVAILABLE'))
    })
  } finally {
    database.close()
  }
}

async function writeVaultRecord(record) {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new DeviceVaultError('Beam could not save the encrypted device vault.', 'STORAGE_UNAVAILABLE'))
      transaction.onabort = () => reject(new DeviceVaultError('Beam could not save the encrypted device vault.', 'STORAGE_UNAVAILABLE'))
    })
  } finally {
    database.close()
  }
}

async function deleteVaultRecord() {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(PRIMARY_VAULT_ID)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new DeviceVaultError('Beam could not remove the local device vault.', 'STORAGE_UNAVAILABLE'))
      transaction.onabort = () => reject(new DeviceVaultError('Beam could not remove the local device vault.', 'STORAGE_UNAVAILABLE'))
    })
  } finally {
    database.close()
  }
}

function validateVaultRecord(record) {
  if (
    !record
    || record.id !== PRIMARY_VAULT_ID
    || record.version !== 1
    || typeof record.beamId !== 'string'
    || !record.beamId.endsWith('.directory')
    || typeof record.credentialId !== 'string'
    || typeof record.salt !== 'string'
    || typeof record.iv !== 'string'
    || typeof record.ciphertext !== 'string'
    || typeof record.createdAt !== 'string'
  ) {
    throw new DeviceVaultError('The saved device vault is invalid.', 'INVALID_VAULT')
  }

  base64UrlToBytes(record.credentialId, 4096)
  const salt = base64UrlToBytes(record.salt, 128)
  const iv = base64UrlToBytes(record.iv, 64)
  const ciphertext = base64UrlToBytes(record.ciphertext, MAX_VAULT_BYTES * 2)
  if (salt.byteLength !== 32 || iv.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > MAX_VAULT_BYTES) {
    throw new DeviceVaultError('The saved device vault is invalid.', 'INVALID_VAULT')
  }
}

function prfResult(credential) {
  const extensions = credential.getClientExtensionResults()
  return asBytes(extensions && extensions.prf && extensions.prf.results && extensions.prf.results.first)
}

async function requestPrf(credentialId, salt) {
  let credential
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{
          id: credentialId,
          type: 'public-key',
        }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })
  } catch (error) {
    if (error && error.name === 'NotAllowedError') {
      throw new DeviceVaultError('Device confirmation was cancelled or timed out.', 'USER_CANCELLED')
    }
    throw new DeviceVaultError('This device could not confirm the Beam passkey.', 'PASSKEY_FAILED')
  }

  const result = credential && prfResult(credential)
  if (!result || result.byteLength !== 32) {
    throw new DeviceVaultError('This passkey cannot protect a Beam device vault.', 'PRF_UNAVAILABLE')
  }
  return result
}

async function createPrfCredential(beamId, salt) {
  const userId = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(beamId)))
  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'Beam' },
        user: {
          id: userId,
          name: beamId,
          displayName: `Beam · ${beamId}`,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })
  } catch (error) {
    if (error && error.name === 'NotAllowedError') {
      throw new DeviceVaultError('Passkey setup was cancelled or timed out.', 'USER_CANCELLED')
    }
    throw new DeviceVaultError('This browser could not create a Beam passkey.', 'PASSKEY_FAILED')
  }

  if (!credential || !credential.rawId) {
    throw new DeviceVaultError('This browser did not return a usable Beam passkey.', 'PASSKEY_FAILED')
  }
  const extensionResults = credential.getClientExtensionResults()
  if (extensionResults && extensionResults.prf && extensionResults.prf.enabled === false) {
    throw new DeviceVaultError('This passkey does not support encrypted Beam device storage.', 'PRF_UNAVAILABLE')
  }

  const credentialId = new Uint8Array(credential.rawId)
  const result = prfResult(credential) ?? await requestPrf(credentialId, salt)
  return { credentialId, result }
}

function additionalData(beamId) {
  return encoder.encode(`beam-device-vault:v1:${beamId}`)
}

async function encryptRecoveryKit(recoveryKit, prfOutput, iv) {
  const plaintext = encoder.encode(JSON.stringify(recoveryKit))
  if (plaintext.byteLength > MAX_VAULT_BYTES - 16) {
    throw new DeviceVaultError('This Beam recovery kit is too large for device storage.', 'VAULT_TOO_LARGE')
  }
  const key = await window.crypto.subtle.importKey('raw', prfOutput, { name: 'AES-GCM' }, false, ['encrypt'])
  return new Uint8Array(await window.crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: additionalData(recoveryKit.beamId),
    tagLength: 128,
  }, key, plaintext))
}

async function decryptRecoveryKit(record, prfOutput) {
  const key = await window.crypto.subtle.importKey('raw', prfOutput, { name: 'AES-GCM' }, false, ['decrypt'])
  let plaintext
  try {
    plaintext = await window.crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64UrlToBytes(record.iv, 64),
      additionalData: additionalData(record.beamId),
      tagLength: 128,
    }, key, base64UrlToBytes(record.ciphertext, MAX_VAULT_BYTES * 2))
  } catch {
    throw new DeviceVaultError('The passkey could not unlock this Beam device vault.', 'DECRYPT_FAILED')
  }

  try {
    const recoveryKit = JSON.parse(decoder.decode(plaintext))
    if (!recoveryKit || recoveryKit.beamId !== record.beamId) throw new Error('Beam ID mismatch')
    return recoveryKit
  } catch {
    throw new DeviceVaultError('The decrypted Beam recovery kit is invalid.', 'INVALID_VAULT')
  }
}

export async function getDeviceVaultMetadata() {
  if (!isDeviceVaultCapable()) return null
  const record = await readVaultRecord()
  if (!record) return null
  validateVaultRecord(record)
  return {
    beamId: record.beamId,
    createdAt: record.createdAt,
  }
}

export async function enrollDeviceVault(recoveryKit) {
  if (!isDeviceVaultCapable()) {
    throw new DeviceVaultError('Passkeys are not available in this browser.', 'UNSUPPORTED')
  }
  if (!recoveryKit || typeof recoveryKit.beamId !== 'string' || !recoveryKit.beamId.endsWith('.directory')) {
    throw new DeviceVaultError('Open a valid Beam recovery kit before enabling this device.', 'INVALID_RECOVERY_KIT')
  }
  if (await readVaultRecord()) {
    throw new DeviceVaultError('A Beam device vault already exists in this browser.', 'VAULT_EXISTS')
  }

  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const { credentialId, result } = await createPrfCredential(recoveryKit.beamId, salt)
  const ciphertext = await encryptRecoveryKit(recoveryKit, result, iv)
  const record = {
    id: PRIMARY_VAULT_ID,
    version: 1,
    beamId: recoveryKit.beamId,
    credentialId: bytesToBase64Url(credentialId),
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
    createdAt: new Date().toISOString(),
  }
  await writeVaultRecord(record)
  return { beamId: record.beamId, createdAt: record.createdAt }
}

export async function unlockDeviceVault() {
  if (!isDeviceVaultCapable()) {
    throw new DeviceVaultError('Passkeys are not available in this browser.', 'UNSUPPORTED')
  }
  const record = await readVaultRecord()
  if (!record) {
    throw new DeviceVaultError('No Beam device vault is configured in this browser.', 'VAULT_NOT_FOUND')
  }
  validateVaultRecord(record)

  const result = await requestPrf(
    base64UrlToBytes(record.credentialId, 4096),
    base64UrlToBytes(record.salt, 128),
  )
  return decryptRecoveryKit(record, result)
}

export async function forgetDeviceVault() {
  if (!window.indexedDB) return
  await deleteVaultRecord()
}
