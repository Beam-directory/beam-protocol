#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BeamClient, BeamIdentity } from '../../packages/sdk-typescript/dist/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[prepare-mcp-pilot-secrets] ${message}`)
  process.exit(1)
}

function writeSecret(directory, name, value) {
  const file = path.join(directory, name)
  writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return file
}

const apply = process.argv.includes('--apply')
const beamId = (valueAfter('--beam-id') ?? 'grok-pilot@beam.directory').trim().toLowerCase()
const directoryUrl = (valueAfter('--directory-url') ?? 'https://api.beam.directory').replace(/\/$/, '')
const secretDirectoryInput = valueAfter('--secret-dir')
const orgApiKeyFileInput = valueAfter('--org-api-key-file')

if (!secretDirectoryInput) fail('--secret-dir with an absolute path outside the repository is required')
const secretDirectory = path.resolve(secretDirectoryInput)
if (!path.isAbsolute(secretDirectoryInput)) fail('--secret-dir must be absolute')
const relativeToRepo = path.relative(repoRoot, secretDirectory)
if (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo)) {
  fail('--secret-dir must be outside the repository')
}

const parsed = BeamIdentity.parseBeamId(beamId)
if (!parsed) fail('--beam-id must be a valid Beam ID')
if (directoryUrl !== 'https://api.beam.directory') {
  fail('the hosted pilot is pinned to https://api.beam.directory')
}

let orgApiKeyFile = null
let orgApiKey
if (parsed.kind === 'organization') {
  if (!orgApiKeyFileInput) {
    fail('organization Beam IDs require --org-api-key-file with the verified organization bootstrap key')
  }
  if (!path.isAbsolute(orgApiKeyFileInput)) fail('--org-api-key-file must be absolute')
  orgApiKeyFile = path.resolve(orgApiKeyFileInput)
  const relativeOrgKeyToRepo = path.relative(repoRoot, orgApiKeyFile)
  if (!relativeOrgKeyToRepo.startsWith('..') && !path.isAbsolute(relativeOrgKeyToRepo)) {
    fail('--org-api-key-file must be outside the repository')
  }
  let metadata
  try {
    metadata = statSync(orgApiKeyFile)
  } catch {
    fail('--org-api-key-file could not be read')
  }
  if (!metadata.isFile()) fail('--org-api-key-file must point to a regular file')
  if (metadata.size < 1 || metadata.size > 4_096) fail('--org-api-key-file must contain 1-4096 bytes')
  if ((metadata.mode & 0o077) !== 0) fail('--org-api-key-file permissions must be 0600 or stricter')
  if (apply) {
    orgApiKey = readFileSync(orgApiKeyFile, 'utf8').trim()
    if (!orgApiKey.startsWith('beam_org_')) {
      fail('--org-api-key-file does not contain a Beam organization API key')
    }
  }
} else if (orgApiKeyFileInput) {
  fail('--org-api-key-file is only valid for organization Beam IDs')
}

const plan = {
  apply,
  beamId,
  directoryUrl,
  secretDirectory,
  organizationProof: orgApiKeyFile ? 'file' : 'not-required',
  files: [
    'postgres_password',
    'keycloak_admin_password',
    'pilot_user_password',
    'mcp_oauth_client_secret',
    'beam_public_key',
    'beam_private_key',
    'beam_dh_public_key',
    'beam_dh_private_key',
    'beam_api_key',
  ],
  sendEnabled: false,
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

mkdirSync(secretDirectory, { recursive: true, mode: 0o700 })
if (readdirSync(secretDirectory).length !== 0) {
  fail('secret directory must be empty; refusing to overwrite existing credentials')
}

const identity = BeamIdentity.generate({ agentName: parsed.agent, orgName: parsed.org })
if (identity.beamId !== beamId) fail('generated identity does not match --beam-id')
const exported = identity.export()

writeSecret(secretDirectory, 'postgres_password', randomBytes(32).toString('base64url'))
writeSecret(secretDirectory, 'keycloak_admin_password', randomBytes(32).toString('base64url'))
writeSecret(secretDirectory, 'pilot_user_password', randomBytes(24).toString('base64url'))
writeSecret(secretDirectory, 'mcp_oauth_client_secret', randomBytes(32).toString('base64url'))
writeSecret(secretDirectory, 'beam_public_key', exported.publicKeyBase64)
writeSecret(secretDirectory, 'beam_private_key', exported.privateKeyBase64)

const networkEncryption = generateKeyPairSync('x25519')
const dhPublicKeyBase64 = networkEncryption.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const dhPrivateKeyBase64 = networkEncryption.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
writeSecret(secretDirectory, 'beam_dh_public_key', dhPublicKeyBase64)
writeSecret(secretDirectory, 'beam_dh_private_key', dhPrivateKeyBase64)

const client = new BeamClient({ identity: exported, directoryUrl, apiKey: orgApiKey })
const registration = await client.register('Grok read-only MCP pilot', ['conversation.message'])
if (!registration.apiKey) fail('Directory registration did not return an API key')
writeSecret(secretDirectory, 'beam_api_key', registration.apiKey)
const encryptionRegistration = await fetch(`${directoryUrl}/agents/${encodeURIComponent(beamId)}/config`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${registration.apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ dhPublicKey: dhPublicKeyBase64 }),
})
if (!encryptionRegistration.ok) fail(`Directory encryption-key registration failed with ${encryptionRegistration.status}`)

writeFileSync(path.join(secretDirectory, 'manifest.json'), `${JSON.stringify({
  beamId,
  directoryUrl,
  createdAt: new Date().toISOString(),
  sendEnabled: false,
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

console.log(JSON.stringify({
  ok: true,
  beamId,
  secretDirectory,
  files: [...plan.files, 'manifest.json'],
  assuranceTier: registration.verificationTier ?? 'basic',
  sendEnabled: false,
}, null, 2))
