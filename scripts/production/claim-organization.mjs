#!/usr/bin/env node

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[claim-organization] ${message}`)
  process.exit(1)
}

function requireValue(flag) {
  const value = valueAfter(flag)?.trim()
  if (!value) fail(`${flag} is required`)
  return value
}

function assertOutsideRepository(target) {
  const relative = path.relative(repoRoot, target)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail('--secret-dir must be outside the repository')
  }
}

const apply = process.argv.includes('--apply')
const name = requireValue('--name').toLowerCase()
const displayName = requireValue('--display-name')
const domain = requireValue('--domain').toLowerCase().replace(/^https?:\/\//u, '').replace(/\/$/u, '')
const directoryUrl = (valueAfter('--directory-url') ?? 'https://api.beam.directory').trim().replace(/\/$/u, '')
const secretDirectoryInput = requireValue('--secret-dir')

if (!/^[a-z0-9_-]+$/u.test(name)) fail('--name has an invalid format')
if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/iu.test(domain)) {
  fail('--domain must be a valid DNS hostname')
}
if (directoryUrl !== 'https://api.beam.directory') {
  fail('production organization claims are pinned to https://api.beam.directory')
}
if (!path.isAbsolute(secretDirectoryInput)) fail('--secret-dir must be absolute')

const secretDirectory = path.resolve(secretDirectoryInput)
assertOutsideRepository(secretDirectory)

const plan = {
  apply,
  name,
  displayName,
  domain,
  directoryUrl,
  secretDirectory,
  outputFile: 'organization.json',
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

mkdirSync(secretDirectory, { recursive: true, mode: 0o700 })
if (readdirSync(secretDirectory).length !== 0) {
  fail('secret directory must be empty; refusing to overwrite an organization credential')
}

const response = await fetch(`${directoryUrl}/orgs`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'beam-organization-onboarding/1.0',
  },
  body: JSON.stringify({ name, displayName, domain }),
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
  fail(`Directory claim failed with HTTP ${response.status}: ${payload?.errorCode ?? payload?.error ?? 'unknown error'}`)
}
if (typeof payload?.apiKey !== 'string' || !payload.apiKey.startsWith('beam_org_')) {
  fail('Directory response did not contain an organization API key')
}
if (payload?.name !== name || payload?.domain !== domain) {
  fail('Directory response does not match the requested organization')
}
if (typeof payload?.verification?.txtName !== 'string' || typeof payload?.verification?.txtValue !== 'string') {
  fail('Directory response did not contain a DNS verification challenge')
}

const credential = {
  format: 'beam-org-claim/v1',
  name: payload.name,
  displayName: payload.displayName,
  domain: payload.domain,
  beamDomain: payload.beamDomain,
  apiKey: payload.apiKey,
  verification: payload.verification,
  claimExpiresAt: payload.claimExpiresAt,
  createdAt: payload.createdAt,
  directoryUrl,
}

const outputFile = path.join(secretDirectory, 'organization.json')
writeFileSync(outputFile, `${JSON.stringify(credential, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx',
})

console.log(JSON.stringify({
  ok: true,
  name: payload.name,
  domain: payload.domain,
  beamDomain: payload.beamDomain,
  verified: payload.verified,
  claimExpiresAt: payload.claimExpiresAt,
  dnsRecord: {
    type: 'TXT',
    name: payload.verification.txtName,
    value: payload.verification.txtValue,
  },
  credentialFile: outputFile,
  credentialPrinted: false,
}, null, 2))
