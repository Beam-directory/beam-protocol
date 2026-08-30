#!/usr/bin/env node

import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[upgrade-mcp-pilot-network-e2ee] ${message}`)
  process.exit(1)
}

function assertPrivateFile(file, label) {
  let metadata
  try {
    metadata = statSync(file)
  } catch {
    fail(`${label} could not be read`)
  }
  if (!metadata.isFile()) fail(`${label} must point to a regular file`)
  if (metadata.size < 1 || metadata.size > 4_096) fail(`${label} must contain 1-4096 bytes`)
  if ((metadata.mode & 0o077) !== 0) fail(`${label} permissions must be 0600 or stricter`)
}

function assertOutsideRepo(directory) {
  const relative = path.relative(repoRoot, directory)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail('--secret-dir must be outside the repository')
  }
}

function writeSecret(directory, name, value) {
  const file = path.join(directory, name)
  writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return file
}

const apply = process.argv.includes('--apply')
const upload = process.argv.includes('--upload')
const beamId = (valueAfter('--beam-id') ?? 'grok@coppen.beam.directory').trim().toLowerCase()
const directoryUrl = (valueAfter('--directory-url') ?? 'https://api.beam.directory').replace(/\/$/, '')
const flyApp = (valueAfter('--fly-app') ?? 'beam-mcp-pilot').trim()
const secretDirectoryInput = valueAfter('--secret-dir')
const apiKeyFileInput = valueAfter('--api-key-file')

if (!secretDirectoryInput || !path.isAbsolute(secretDirectoryInput)) {
  fail('--secret-dir with an absolute path outside the repository is required')
}
if (!apiKeyFileInput || !path.isAbsolute(apiKeyFileInput)) {
  fail('--api-key-file with an absolute path is required')
}
if (upload && !apply) fail('--upload requires --apply')
if (directoryUrl !== 'https://api.beam.directory') fail('the hosted pilot is pinned to https://api.beam.directory')
if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+$/.test(beamId)) fail('--beam-id is invalid')
if (!/^[a-z0-9][a-z0-9-]*$/.test(flyApp)) fail('--fly-app is invalid')

const secretDirectory = path.resolve(secretDirectoryInput)
const apiKeyFile = path.resolve(apiKeyFileInput)
assertOutsideRepo(secretDirectory)
assertPrivateFile(apiKeyFile, '--api-key-file')

const plan = {
  apply,
  upload,
  beamId,
  directoryUrl,
  flyApp,
  secretDirectory,
  creates: ['beam_dh_public_key', 'beam_dh_private_key'],
  effects: ['register public X25519 key in Beam Directory', ...(upload ? ['upload two Fly file secrets'] : [])],
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

mkdirSync(secretDirectory, { recursive: true, mode: 0o700 })
const apiKey = readFileSync(apiKeyFile, 'utf8').trim()
if (!apiKey.startsWith('bk_')) fail('--api-key-file does not contain a Beam agent API key')

const encryption = generateKeyPairSync('x25519')
const publicKey = encryption.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const privateKey = encryption.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const publicFile = writeSecret(secretDirectory, 'beam_dh_public_key', publicKey)
const privateFile = writeSecret(secretDirectory, 'beam_dh_private_key', privateKey)

const response = await fetch(`${directoryUrl}/agents/${encodeURIComponent(beamId)}/config`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ dhPublicKey: publicKey }),
})
if (!response.ok) fail(`Directory encryption-key registration failed with ${response.status}`)
const registered = await response.json()
if (registered.dhPublicKey !== publicKey) fail('Directory registration response did not return the public key')

if (upload) {
  const flySecrets = [
    `MCP_BEAM_DH_PUBLIC_KEY_B64=${Buffer.from(readFileSync(publicFile)).toString('base64')}`,
    `MCP_BEAM_DH_PRIVATE_KEY_B64=${Buffer.from(readFileSync(privateFile)).toString('base64')}`,
    '',
  ].join('\n')
  const result = spawnSync('flyctl', ['secrets', 'import', '-a', flyApp], {
    input: flySecrets,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) fail(`Fly secret import failed: ${(result.stderr || result.stdout).trim()}`)
}

const verifyResponse = await fetch(`${directoryUrl}/agents/${encodeURIComponent(beamId)}`)
if (!verifyResponse.ok) fail(`Directory public-key readback failed with ${verifyResponse.status}`)
const verify = await verifyResponse.json()
if (verify.dhPublicKey !== publicKey && verify.dh_public_key !== publicKey) {
  fail('Directory public-key readback did not return the registered public key')
}

console.log(JSON.stringify({
  ok: true,
  beamId,
  directoryRegistered: true,
  flySecretsUploaded: upload,
  files: [publicFile, privateFile],
}, null, 2))
