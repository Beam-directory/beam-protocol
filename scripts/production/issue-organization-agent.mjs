#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[issue-organization-agent] ${message}`)
  process.exit(1)
}

function requireValue(flag) {
  const value = valueAfter(flag)?.trim()
  if (!value) fail(`${flag} is required`)
  return value
}

function assertSecretFile(file, flag) {
  if (!path.isAbsolute(file)) fail(`${flag} must be absolute`)
  const relative = path.relative(repoRoot, file)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail(`${flag} must be outside the repository`)
  const metadata = statSync(file)
  if (!metadata.isFile()) fail(`${flag} must point to a regular file`)
  if ((metadata.mode & 0o077) !== 0) fail(`${flag} permissions must be 0600 or stricter`)
}

const apply = process.argv.includes('--apply')
const orgCredentialFile = path.resolve(requireValue('--org-credential-file'))
const agentName = requireValue('--agent-name').toLowerCase()
const displayName = requireValue('--display-name')
const capabilities = (valueAfter('--capabilities') ?? 'conversation.message')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const outputFile = path.resolve(requireValue('--output-file'))

if (!/^[a-z0-9_-]+$/u.test(agentName)) fail('--agent-name has an invalid format')
if (capabilities.length < 1 || capabilities.length > 50) fail('--capabilities must contain 1-50 entries')
assertSecretFile(orgCredentialFile, '--org-credential-file')
if (!path.isAbsolute(outputFile)) fail('--output-file must be absolute')
const outputRelative = path.relative(repoRoot, outputFile)
if (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative)) fail('--output-file must be outside the repository')

let orgCredential
try {
  orgCredential = JSON.parse(readFileSync(orgCredentialFile, 'utf8'))
} catch {
  fail('--org-credential-file does not contain valid JSON')
}
if (orgCredential?.format !== 'beam-org-claim/v1' || typeof orgCredential?.apiKey !== 'string' || !orgCredential.apiKey.startsWith('beam_org_')) {
  fail('--org-credential-file is not a Beam organization credential')
}
if (orgCredential?.directoryUrl !== 'https://api.beam.directory') {
  fail('organization credential is not pinned to https://api.beam.directory')
}

const beamId = `${agentName}@${orgCredential.name}.beam.directory`
const plan = {
  apply,
  organization: orgCredential.name,
  beamId,
  displayName,
  capabilities,
  directoryUrl: orgCredential.directoryUrl,
  outputFile,
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

const response = await fetch(`${orgCredential.directoryUrl}/orgs/${encodeURIComponent(orgCredential.name)}/agents`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${orgCredential.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'beam-organization-onboarding/1.0',
  },
  body: JSON.stringify({ agentName, displayName, capabilities }),
  signal: AbortSignal.timeout(15_000),
})

const text = await response.text()
let payload
try {
  payload = JSON.parse(text)
} catch {
  fail(`Directory returned non-JSON HTTP ${response.status}`)
}
if (!response.ok) {
  fail(`Directory agent issuance failed with HTTP ${response.status}: ${payload?.errorCode ?? payload?.error ?? 'unknown error'}`)
}
if (payload?.beamId !== beamId || typeof payload?.apiKey !== 'string' || typeof payload?.privateKeyBase64 !== 'string') {
  fail('Directory response did not contain the expected one-time agent credential')
}

const credential = {
  format: 'beam-agent-credential/v1',
  beamId: payload.beamId,
  did: payload.did,
  displayName: payload.displayName,
  org: payload.org,
  capabilities: payload.capabilities,
  publicKeyBase64: payload.publicKeyBase64,
  privateKeyBase64: payload.privateKeyBase64,
  apiKey: payload.apiKey,
  directoryUrl: orgCredential.directoryUrl,
  createdAt: payload.createdAt,
}

writeFileSync(outputFile, `${JSON.stringify(credential, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx',
})

console.log(JSON.stringify({
  ok: true,
  organization: orgCredential.name,
  beamId: payload.beamId,
  did: payload.did,
  displayName: payload.displayName,
  capabilities: payload.capabilities,
  credentialFile: outputFile,
  credentialPrinted: false,
}, null, 2))
