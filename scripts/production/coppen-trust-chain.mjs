#!/usr/bin/env node

// Wires an organization's agents to one responsible person and a signed
// mandate, so the directory trust assertion carries `person` and `mandate`.
// Default is a dry run. Nothing is written without --apply.
// The person's private key is read from a local file, used to sign locally,
// and never printed or sent.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { optionalFlag, repoRoot } from './shared.mjs'

export const PRODUCTION_DIRECTORY_URL = 'https://api.beam.directory'
// Must equal DIRECTORY_SIGNING_PUBLIC_KEY in packages/sdk-typescript/src/trust-assertion.ts.
export const PINNED_DIRECTORY_KEY = 'MCowBQYDK2VwAyEA0oRW/jimdiEvI4JkjY2hWfhfyS/qQGmNd5njKYI6jnk='
export const KNOWN_ACTIONS = ['read', 'schedule.commit', 'file.send', 'order']
// `order` is the scope the directory maps `order.place` and `payment.submit` to.
export const FORBIDDEN_ACTIONS = ['order']
export const KEY_FORMAT = 'beam-person-key/v1'
export const DEFAULT_VALIDITY_DAYS = 90
export const MAX_AGENTS = 10
export const RENEW_WITHIN_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_VALIDITY_DAYS = 366
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const ORG_RE = /^[a-z0-9_-]+$/u
const BEAM_ID_RE = /^([a-z0-9_-]+)@([a-z0-9_-]+\.beam\.directory)$/u
const JTI_RE = /^[A-Za-z0-9_-]{8,80}$/u
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export class TrustChainError extends Error {}

function fail(message) {
  throw new TrustChainError(message)
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key])
    return sorted
  }
  return value
}

export function canonicalizeJson(value) {
  return JSON.stringify(sortJson(value))
}

export function personRef(personId) {
  return createHash('sha256').update(personId).digest('hex')
}

export function keyFingerprint(publicKeyBase64) {
  return `ed25519:${createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16)}`
}

function assertOutsideRepository(target) {
  const relative = path.relative(repoRoot, target)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail(`${target} is inside the repository. Keep the person key outside the repository.`)
  }
}

export function generatePersonKeyFile(outPath, { now = new Date() } = {}) {
  const target = path.resolve(outPath)
  assertOutsideRepository(target)
  if (existsSync(target)) fail(`${target} already exists. Refusing to overwrite a person key.`)
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const record = {
    format: KEY_FORMAT,
    publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: now.toISOString(),
  }
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(target, 0o600)
  return { path: target, publicKey, fingerprint: keyFingerprint(publicKey) }
}

export function loadPersonKey(keyPath) {
  const target = path.resolve(keyPath)
  if (!existsSync(target)) fail(`Person key file ${target} does not exist`)
  if (process.platform !== 'win32' && (statSync(target).mode & 0o077) !== 0) {
    fail(`Person key file ${target} is readable by others. Run: chmod 600 ${target}`)
  }
  let record
  try {
    record = JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    fail(`Person key file ${target} is not valid JSON`)
  }
  if (record?.format !== KEY_FORMAT || typeof record.privateKey !== 'string' || typeof record.publicKey !== 'string') {
    fail(`Person key file ${target} is not a ${KEY_FORMAT} file`)
  }
  let privateKey
  try {
    privateKey = createPrivateKey({ key: Buffer.from(record.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    fail(`Person key file ${target} does not contain a readable private key`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail(`Person key file ${target} is not an Ed25519 key`)
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
  if (derived !== record.publicKey) fail(`Person key file ${target}: the public key does not match the private key`)
  return { privateKey, publicKey: derived, fingerprint: keyFingerprint(derived) }
}

export function signPayload(payload, privateKey) {
  return sign(null, Buffer.from(canonicalizeJson(payload), 'utf8'), privateKey).toString('base64')
}

function verifyText(text, signatureBase64, publicKeyBase64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** Same bytes as assertionSignedPayload() in packages/directory/src/trust/assertion.ts. */
export function assertionSigningText(assertion) {
  const { signature: _signature, publicKey: _publicKey, ...unsigned } = assertion
  return canonicalizeJson(unsigned)
}

export function verifyAssertionSignature(assertion, publicKeyBase64) {
  if (!assertion || typeof assertion.signature !== 'string') return false
  return verifyText(assertionSigningText(assertion), assertion.signature, publicKeyBase64)
}

function parseScopes(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where}: scopes must be an object`)
  for (const key of Object.keys(value)) {
    if (key !== 'actions' && key !== 'file') fail(`${where}: unknown scope field "${key}"`)
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) fail(`${where}: scopes.actions must list at least one action`)
  const actions = []
  for (const action of value.actions) {
    if (FORBIDDEN_ACTIONS.includes(action)) fail(`${where}: "${action}" is not allowed here. These agents may never order or pay.`)
    if (!KNOWN_ACTIONS.includes(action)) fail(`${where}: unknown action "${action}". Known: ${KNOWN_ACTIONS.join(', ')}`)
    if (actions.includes(action)) fail(`${where}: action "${action}" is listed twice`)
    actions.push(action)
  }
  const scopes = { actions }
  if (value.file !== undefined) {
    const maxBytes = value.file?.maxBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !actions.includes('file.send')) {
      fail(`${where}: scopes.file.maxBytes must be a positive integer and needs "file.send"`)
    }
    scopes.file = { maxBytes }
  }
  return scopes
}

export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config must be a JSON object')
  const org = typeof raw.org === 'string' ? raw.org.trim().toLowerCase() : ''
  if (!ORG_RE.test(org)) fail('config.org must be an organization name like "coppen"')
  const person = raw.person ?? {}
  const email = typeof person.email === 'string' ? person.email.trim().toLowerCase() : ''
  const displayName = typeof person.displayName === 'string' ? person.displayName.trim() : ''
  const role = typeof person.role === 'string' ? person.role.trim() : ''
  if (!EMAIL_RE.test(email)) fail('config.person.email must be an email address')
  if (displayName.length < 1 || displayName.length > 120) fail('config.person.displayName is required')
  if (role.length < 1 || role.length > 80) fail('config.person.role is required (1 to 80 characters)')
  const kycNote = typeof raw.kyc?.note === 'string' ? raw.kyc.note.trim() : ''
  if (kycNote.length < 3) fail('config.kyc.note is required. Write what the operator checked.')
  const validityDays = raw.validityDays ?? DEFAULT_VALIDITY_DAYS
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    fail(`config.validityDays must be a whole number from 1 to ${MAX_VALIDITY_DAYS}`)
  }
  const defaultScopes = raw.defaultScopes === undefined ? null : parseScopes(raw.defaultScopes, 'config.defaultScopes')
  if (!Array.isArray(raw.agents) || raw.agents.length < 1 || raw.agents.length > MAX_AGENTS) {
    fail(`config.agents must list 1 to ${MAX_AGENTS} agents`)
  }
  const agents = []
  for (const [index, entry] of raw.agents.entries()) {
    const beamId = typeof entry?.beamId === 'string' ? entry.beamId.trim().toLowerCase() : ''
    const match = BEAM_ID_RE.exec(beamId)
    if (!match) fail(`config.agents[${index}].beamId must look like name@${org}.beam.directory`)
    if (agents.some((agent) => agent.beamId === beamId)) fail(`config.agents: ${beamId} is listed twice`)
    const scopes = entry.scopes === undefined ? defaultScopes : parseScopes(entry.scopes, `config.agents[${index}]`)
    if (!scopes) fail(`config.agents[${index}] has no scopes and there are no defaultScopes`)
    agents.push({ beamId, agentName: match[1], beamDomain: match[2], scopes })
  }
  return { org, person: { email, displayName, role }, kycNote, validityDays, agents }
}

export function sameScopes(left, right) {
  if (!left || !right || !Array.isArray(left.actions) || !Array.isArray(right.actions)) return false
  if (left.actions.length !== right.actions.length || left.actions.some((action) => !right.actions.includes(action))) return false
  if ((left.file?.maxBytes ?? null) !== (right.file?.maxBytes ?? null)) return false
  return JSON.stringify(left.order ?? null) === JSON.stringify(right.order ?? null)
}

/** Mirrors scopeWithin() in packages/directory/src/trust/scopes.ts for the actions this script grants. */
export function scopeWithin(child, parent) {
  if (!parent || !Array.isArray(parent.actions)) return false
  if (child.actions.some((action) => !parent.actions.includes(action))) return false
  if (child.actions.includes('file.send') && parent.file) {
    if (!child.file || child.file.maxBytes > parent.file.maxBytes) return false
  }
  return true
}

/** Smallest widening of the person's rights that covers every agent mandate. Never narrows. */
export function rightsCovering(current, scopesList) {
  const base = current && Array.isArray(current.actions) ? current : { actions: [] }
  const actions = [...base.actions]
  for (const scopes of scopesList) {
    for (const action of scopes.actions) if (!actions.includes(action)) actions.push(action)
  }
  const next = { actions }
  if (base.order) next.order = base.order
  if (base.file) {
    const needsUnlimited = scopesList.some((scopes) => scopes.actions.includes('file.send') && !scopes.file)
    if (!needsUnlimited) {
      const maxBytes = Math.max(base.file.maxBytes, ...scopesList.map((scopes) => scopes.file?.maxBytes ?? 0))
      next.file = { maxBytes }
    }
  }
  return next
}

export function mandateTerms(now, validityDays) {
  const issuedOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const stamp = issuedOn.toISOString().slice(0, 10).replaceAll('-', '')
  return { stamp, expiresAt: new Date(issuedOn.getTime() + validityDays * DAY_MS).toISOString() }
}

export function mandateJti(org, agentName, stamp, issueTag = '') {
  const jti = issueTag ? `${org}-${agentName}-${stamp}-${issueTag}` : `${org}-${agentName}-${stamp}`
  if (!JTI_RE.test(jti)) fail(`Mandate id ${jti} is not valid (8 to 80 of A-Z a-z 0-9 _ -)`)
  return jti
}

export function mandatePayload({ jti, personId, beamId, org, scopes, expiresAt, escalationPersonId }) {
  return {
    type: 'mandate',
    jti,
    version: 1,
    personId,
    agentBeamId: beamId,
    org,
    scopes,
    expiresAt,
    escalationPersonId: escalationPersonId ?? null,
  }
}

export function revokePayload({ jti, personId }) {
  return { type: 'mandate-revoke', jti, personId }
}

export function checkDirectoryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`--directory-url ${value} is not a URL`)
  }
  const base = url.origin
  if (base === PRODUCTION_DIRECTORY_URL) return { base, production: true }
  if (LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(`[${url.hostname}]`)) return { base, production: false }
  fail(`--directory-url must be ${PRODUCTION_DIRECTORY_URL} or a local directory (localhost)`)
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body
  const copy = { ...body }
  if (typeof copy.signature === 'string' && !copy.signature.startsWith('<')) copy.signature = `<signature, ${copy.signature.length} chars, not shown>`
  if (typeof copy.publicKey === 'string') copy.publicKey = `${copy.publicKey} (${keyFingerprint(copy.publicKey)})`
  return copy
}

function indent(text, prefix = '      ') {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n')
}

function createClient({ base, fetchImpl, apply, orgApiKey, adminToken, log }) {
  async function call(method, pathname, { body, auth = 'org', write = false, label } = {}) {
    const url = `${base}${pathname}`
    const tag = write ? (apply ? 'WRITE' : 'WOULD') : 'READ '
    log(`  ${tag} ${method} ${url}${label ? `   # ${label}` : ''}`)
    if (auth === 'org') log('        auth: x-api-key <org API key, not shown>')
    if (auth === 'admin') log('        auth: Authorization: Bearer <operator session, not shown>')
    if (body !== undefined) log(`        body:\n${indent(JSON.stringify(redactBody(body), null, 2), '          ')}`)
    if (write && !apply) return { status: null, body: null, skipped: true }
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth === 'org') {
      if (!orgApiKey) fail('An org API key is required (BEAM_ORG_API_KEY or --org-credential)')
      headers['x-api-key'] = orgApiKey
    }
    if (auth === 'admin') {
      if (!adminToken) fail('An operator session is required (BEAM_ADMIN_TOKEN or --admin-token-file)')
      headers.authorization = `Bearer ${adminToken}`
    }
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text.slice(0, 240) }
      }
    }
    const code = parsed?.errorCode ? ` ${parsed.errorCode}` : ''
    log(`        -> ${response.status}${code}`)
    return { status: response.status, body: parsed, skipped: false }
  }
  return { call }
}

function expectStatus(result, allowed, what) {
  if (allowed.includes(result.status)) return result.body
  const reason = result.body?.error ?? result.body?.raw ?? 'no details'
  fail(`${what} failed with ${result.status}${result.body?.errorCode ? ` ${result.body.errorCode}` : ''}: ${reason}`)
}

function assertionView(assertion) {
  return {
    person: assertion?.person ?? null,
    mandate: assertion?.mandate ?? null,
    org: assertion?.org ?? null,
    suspended: assertion?.suspended ?? null,
  }
}

/**
 * Runs the trust chain for one config. Reads first, then writes in order, then
 * reads every assertion back and checks it against the pinned directory key.
 */
export async function runTrustChain({
  config,
  key,
  directoryUrl,
  apply = false,
  offline = false,
  replacePersonKey = false,
  orgApiKey = '',
  adminToken = '',
  issuerPublicKey = '',
  issueTag = '',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  log = console.log,
}) {
  const { base, production } = checkDirectoryUrl(directoryUrl)
  if (offline && apply) fail('--offline cannot be combined with --apply')
  const pinnedKey = issuerPublicKey || (production ? PINNED_DIRECTORY_KEY : '')
  const client = createClient({ base, fetchImpl, apply, orgApiKey, adminToken, log })
  const { stamp, expiresAt } = mandateTerms(now, config.validityDays)
  const warnings = []
  const warn = (message) => {
    warnings.push(message)
    log(`  WARN  ${message}`)
  }

  log(`[coppen-trust-chain] ${apply ? 'APPLY: write calls will be sent' : 'DRY RUN: no write calls are sent. Add --apply to write.'}`)
  log(`  directory:   ${base}${production ? ' (production)' : ' (local)'}`)
  log(`  org:         ${config.org}`)
  log(`  person:      ${config.person.displayName} <${config.person.email}>, role "${config.person.role}"`)
  log(`  person key:  ${key.fingerprint} (public part only; the private key stays in the local file)`)
  log(`  mandates:    ${config.validityDays} days, expire ${expiresAt}`)
  log(`  issuer key:  ${pinnedKey ? keyFingerprint(pinnedKey) : 'not pinned (local run without --issuer-public-key)'}`)
  for (const agent of config.agents) log(`  agent:       ${agent.beamId} may ${agent.scopes.actions.join(', ')}`)

  log('\n[1/6] Organization')
  let beamDomain = `${config.org}.beam.directory`
  if (offline) {
    log('  OFFLINE: assuming the organization exists, is verified and lists every agent')
  } else {
    const body = expectStatus(await client.call('GET', `/orgs/${encodeURIComponent(config.org)}`), [200], 'Reading the organization')
    if (body?.org?.verified !== true) fail(`Organization ${config.org} is not domain-verified. Verify the domain first.`)
    beamDomain = body.org.beamDomain ?? beamDomain
    const listed = new Set((body.agents ?? []).map((agent) => agent.beamId))
    log(`        org ${body.org.name}, domain ${body.org.domain}, verified, ${listed.size} agents`)
    for (const agent of config.agents) {
      if (!listed.has(agent.beamId)) fail(`${agent.beamId} is not an agent of organization ${config.org}`)
    }
  }
  for (const agent of config.agents) {
    if (agent.beamDomain !== beamDomain) fail(`${agent.beamId} is not under ${beamDomain}`)
  }

  log('\n[2/6] Responsible person')
  const allScopes = config.agents.map((agent) => agent.scopes)
  let person = null
  if (!offline) {
    const body = expectStatus(await client.call('GET', `/orgs/${encodeURIComponent(config.org)}/people`), [200], 'Listing people')
    person = (body?.people ?? []).find((entry) => entry.email === config.person.email) ?? null
    log(person
      ? `        found ${person.email}: id ${person.id}, status ${person.status}, KYC ${person.kycStatus}, key ${person.publicKey ? keyFingerprint(person.publicKey) : 'none'}`
      : `        no person with ${config.person.email} yet`)
  }
  if (person && person.status !== 'active') fail(`${config.person.email} is ${person.status}. An active person is required.`)
  const keyMismatch = Boolean(person && person.publicKey !== key.publicKey)
  if (keyMismatch && !replacePersonKey) {
    fail([
      `${config.person.email} already has a different public key (${person.publicKey ? keyFingerprint(person.publicKey) : 'none'}).`,
      'Replacing it resets KYC to pending and revokes this person\'s active mandates.',
      'Use the existing key file, or pass --replace-person-key if that is intended.',
    ].join(' '))
  }

  log('\n[3/6] Trust assertions before any change')
  const before = new Map()
  for (const agent of config.agents) {
    if (offline) {
      before.set(agent.beamId, null)
      continue
    }
    const body = expectStatus(
      await client.call('GET', `/agents/${encodeURIComponent(agent.beamId)}/trust-assertion`),
      [200],
      `Reading the trust assertion of ${agent.beamId}`,
    )
    before.set(agent.beamId, body)
    log(`        person ${body?.person ? body.person.ref.slice(0, 12) : 'null'}, mandate ${body?.mandate ? `${body.mandate.jti} (${body.mandate.scopes.actions.join(', ')})` : 'null'}`)
  }

  const kycNeeded = !person || keyMismatch || person.kycStatus !== 'verified'
  if (person?.kycStatus === 'rejected' && !keyMismatch) {
    fail(`KYC for ${config.person.email} was rejected. Resolve that by hand (see docs/runbooks/manual-kyc.md).`)
  }
  if (apply && !orgApiKey) fail('--apply needs the org API key (BEAM_ORG_API_KEY or --org-credential)')
  if (apply && kycNeeded && !adminToken) {
    fail('--apply needs an operator session for the KYC review (BEAM_ADMIN_TOKEN or --admin-token-file). Nothing was written.')
  }
  if (!apply && kycNeeded && !adminToken) {
    log('  NOTE  The KYC review needs an operator session. Set BEAM_ADMIN_TOKEN before --apply.')
  }

  log('\n[4/6] Person record, key, rights and KYC')
  const placeholderId = '{personId from step 4}'
  let personId = person?.id ?? null
  let kycStatus = person?.kycStatus ?? 'unverified'
  let supervisorPersonId = person?.supervisorPersonId ?? null
  if (!person) {
    const result = await client.call('POST', `/orgs/${encodeURIComponent(config.org)}/people`, {
      write: true,
      label: 'create the person with the locally generated public key',
      body: {
        email: config.person.email,
        displayName: config.person.displayName,
        role: config.person.role,
        publicKey: key.publicKey,
        rights: rightsCovering(null, allScopes),
      },
    })
    if (!result.skipped) {
      const created = expectStatus(result, [201], 'Creating the person').person
      personId = created.id
      kycStatus = created.kycStatus
      supervisorPersonId = created.supervisorPersonId ?? null
    }
  } else {
    if (person.displayName !== config.person.displayName || person.role !== config.person.role) {
      warn(`The stored name/role ("${person.displayName}", "${person.role}") differ from the config. This script does not change them.`)
    }
    if (keyMismatch) {
      warn('Replacing the person key. KYC goes back to pending and active mandates of this person are revoked.')
      const result = await client.call('PATCH', `/orgs/${encodeURIComponent(config.org)}/people/${encodeURIComponent(person.id)}`, {
        write: true,
        label: 'replace the person public key',
        body: { publicKey: key.publicKey },
      })
      if (!result.skipped) kycStatus = expectStatus(result, [200], 'Replacing the person key').person.kycStatus
      else kycStatus = 'pending'
    } else {
      log(`  SKIP  public key already set (${key.fingerprint})`)
    }
    const coversAll = allScopes.every((scopes) => scopeWithin(scopes, person.rights))
    if (coversAll) {
      log(`  SKIP  person rights already cover the mandates (${person.rights.actions.join(', ')})`)
    } else {
      const result = await client.call('PATCH', `/orgs/${encodeURIComponent(config.org)}/people/${encodeURIComponent(person.id)}`, {
        write: true,
        label: 'widen the person rights so the mandates fit inside them',
        body: { rights: rightsCovering(person.rights, allScopes) },
      })
      if (!result.skipped) expectStatus(result, [200], 'Updating the person rights')
    }
  }

  const idForPath = personId ? encodeURIComponent(personId) : placeholderId
  if (kycStatus === 'verified') {
    log('  SKIP  KYC already verified')
  } else {
    if (kycStatus === 'unverified' || kycStatus === 'rejected') {
      const result = await client.call('POST', `/orgs/${encodeURIComponent(config.org)}/people/${idForPath}/kyc`, {
        write: true,
        label: 'org requests the manual KYC review',
        body: { provider: 'manual' },
      })
      if (!result.skipped) kycStatus = expectStatus(result, [200], 'Requesting KYC').person.kycStatus
    }
    const result = await client.call('POST', `/admin/people/${idForPath}/kyc`, {
      write: true,
      auth: 'admin',
      label: 'operator records the manual KYC review',
      body: { status: 'verified', note: config.kycNote },
    })
    if (!result.skipped) kycStatus = expectStatus(result, [200], 'Recording the KYC review').person.kycStatus
  }

  log('\n[5/6] Responsible person and signed mandate per agent')
  const ref = personId ? personRef(personId) : null
  const planned = []
  for (const agent of config.agents) {
    log(`  ${agent.beamId}`)
    const current = before.get(agent.beamId)
    const alreadyResponsible = Boolean(ref && current?.person?.ref === ref)
    if (alreadyResponsible) {
      log('  SKIP  responsible person already set')
    } else {
      if (current?.person) {
        warn(`${agent.beamId} has another responsible person (${current.person.ref.slice(0, 12)}). Replacing revokes that person's mandates for this agent.`)
      }
      const result = await client.call('PUT', `/orgs/${encodeURIComponent(config.org)}/agents/${encodeURIComponent(agent.agentName)}/responsible-person`, {
        write: true,
        label: 'set the responsible person',
        body: { responsiblePersonId: personId ?? placeholderId },
      })
      if (!result.skipped) expectStatus(result, [200], `Setting the responsible person of ${agent.beamId}`)
    }

    const existing = alreadyResponsible ? current?.mandate ?? null : null
    const scopesMatch = Boolean(existing && sameScopes(existing.scopes, agent.scopes))
    if (existing && scopesMatch && Date.parse(existing.expiresAt) > now.getTime() + RENEW_WITHIN_DAYS * DAY_MS) {
      log(`  SKIP  active mandate ${existing.jti} already has these scopes, expires ${existing.expiresAt}`)
      planned.push({ beamId: agent.beamId, jti: existing.jti })
      continue
    }
    if (existing && scopesMatch) {
      log(`  RENEW mandate ${existing.jti} expires ${existing.expiresAt}, within ${RENEW_WITHIN_DAYS} days. A new one is issued; the old one runs out on its own.`)
    } else if (existing) {
      warn(`${agent.beamId}: mandate ${existing.jti} (${existing.scopes.actions.join(', ')}) stays active until revoked. Revoke it after this run: revoke --agent ${agent.beamId} --jti ${existing.jti}`)
    }
    const jti = mandateJti(config.org, agent.agentName, stamp, issueTag)
    const payload = mandatePayload({
      jti,
      personId: personId ?? placeholderId,
      beamId: agent.beamId,
      org: config.org,
      scopes: agent.scopes,
      expiresAt,
      escalationPersonId: supervisorPersonId,
    })
    log(`        signed locally: ${canonicalizeJson(payload)}`)
    const signature = personId ? signPayload(payload, key.privateKey) : '<signed on --apply with the local person key>'
    const result = await client.call('POST', `/agents/${encodeURIComponent(agent.beamId)}/mandates`, {
      write: true,
      auth: 'none',
      label: 'post the mandate signed by the person key',
      body: { jti, scopes: agent.scopes, expiresAt, escalationPersonId: payload.escalationPersonId, signature },
    })
    if (!result.skipped) {
      if (result.status === 409 && result.body?.errorCode === 'MANDATE_REPLAY') {
        log('  SKIP  this exact signed mandate was already recorded (MANDATE_REPLAY)')
      } else {
        expectStatus(result, [201], `Posting the mandate for ${agent.beamId}`)
      }
    }
    planned.push({ beamId: agent.beamId, jti })
  }

  log(`\n[6/6] Read back and verify${apply ? '' : ' (dry run: this is the current state, nothing was changed)'}`)
  const results = []
  for (const agent of config.agents) {
    let assertion = before.get(agent.beamId)
    if (apply) {
      assertion = expectStatus(
        await client.call('GET', `/agents/${encodeURIComponent(agent.beamId)}/trust-assertion`),
        [200],
        `Reading back ${agent.beamId}`,
      )
    }
    if (!assertion) {
      log(`  ${agent.beamId}: no assertion read (offline)`)
      results.push({ beamId: agent.beamId, ok: false, signatureValid: null, ...assertionView(null) })
      continue
    }
    const verifyKey = pinnedKey || assertion.publicKey
    const signatureValid = verifyAssertionSignature(assertion, verifyKey)
    const want = planned.find((entry) => entry.beamId === agent.beamId)
    const problems = []
    if (!signatureValid) problems.push(pinnedKey ? 'signature does not verify against the pinned key' : 'signature does not verify')
    if (pinnedKey && assertion.publicKey !== pinnedKey) problems.push('assertion key differs from the pinned key')
    if (assertion.v !== 1 || assertion.beamId !== agent.beamId) problems.push('unexpected assertion header')
    if (!assertion.org?.verified) problems.push('org not verified')
    if (assertion.suspended) problems.push('agent suspended')
    if (!ref || assertion.person?.ref !== ref) problems.push('person is not the configured person')
    if (assertion.person && assertion.person.kycStatus !== 'verified') problems.push(`person KYC is ${assertion.person.kycStatus}`)
    if (!assertion.mandate) problems.push('mandate is null')
    else {
      if (!sameScopes(assertion.mandate.scopes, agent.scopes)) problems.push('mandate scopes differ from the config')
      if (assertion.mandate.scopes.actions.some((action) => FORBIDDEN_ACTIONS.includes(action))) problems.push('mandate allows ordering or payments')
      if (want && assertion.mandate.jti !== want.jti) problems.push(`mandate is ${assertion.mandate.jti}, expected ${want.jti}`)
    }
    const ok = problems.length === 0
    log(`  ${ok ? 'OK  ' : 'TODO'}  ${agent.beamId}: signature ${signatureValid ? 'valid' : 'INVALID'}${pinnedKey ? ' (pinned key)' : ' (key from response, not pinned)'}`)
    log(indent(JSON.stringify(assertionView(assertion), null, 2), '        '))
    if (!ok) log(`        open: ${problems.join('; ')}`)
    results.push({ beamId: agent.beamId, ok, signatureValid, problems, ...assertionView(assertion) })
  }

  const ok = results.every((entry) => entry.ok)
  log(`\n[coppen-trust-chain] ${apply ? (ok ? 'DONE: every agent has person and mandate in a verified assertion.' : 'NOT DONE: see the open points above.') : 'DRY RUN finished. No write call was sent.'}`)
  return { ok, apply, personId, results, warnings }
}

export async function runRevoke({
  config,
  key,
  directoryUrl,
  beamId,
  jti,
  personId: givenPersonId = '',
  apply = false,
  orgApiKey = '',
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const { base } = checkDirectoryUrl(directoryUrl)
  if (!JTI_RE.test(jti)) fail('--jti is not a valid mandate id')
  if (!config.agents.some((agent) => agent.beamId === beamId)) fail(`--agent ${beamId} is not in the config`)
  const client = createClient({ base, fetchImpl, apply, orgApiKey, adminToken: '', log })
  log(`[coppen-trust-chain] revoke ${jti} for ${beamId}: ${apply ? 'APPLY' : 'DRY RUN, add --apply to send'}`)
  let personId = givenPersonId
  if (!personId) {
    const body = expectStatus(await client.call('GET', `/orgs/${encodeURIComponent(config.org)}/people`), [200], 'Listing people')
    personId = (body?.people ?? []).find((entry) => entry.email === config.person.email)?.id ?? ''
    if (!personId) fail(`No person with ${config.person.email} in ${config.org}`)
  }
  const payload = revokePayload({ jti, personId })
  log(`        signed locally: ${canonicalizeJson(payload)}`)
  const result = await client.call('POST', `/agents/${encodeURIComponent(beamId)}/mandates/${encodeURIComponent(jti)}/revoke`, {
    write: true,
    auth: 'none',
    label: 'revoke, signed by the person key',
    body: { signature: signPayload(payload, key.privateKey) },
  })
  if (result.skipped) return { ok: true, apply: false }
  const mandate = expectStatus(result, [200], 'Revoking the mandate').mandate
  log(`        mandate ${mandate?.jti} is ${mandate?.status}`)
  return { ok: mandate?.status === 'revoked', apply: true, mandate }
}

function readSecretFile(filePath) {
  const text = readFileSync(path.resolve(filePath), 'utf8').trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text)
    return typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : typeof parsed.token === 'string' ? parsed.token.trim() : ''
  }
  return text
}

function usage() {
  return [
    'Usage:',
    '  node scripts/production/coppen-trust-chain.mjs keygen --out <file outside the repo>',
    '  node scripts/production/coppen-trust-chain.mjs --config <config.json> --key <person-key.json> [--apply]',
    '  node scripts/production/coppen-trust-chain.mjs revoke --config <config.json> --key <person-key.json> --agent <beamId> --jti <id> [--apply]',
    '',
    'Options:',
    `  --directory-url <url>      default ${PRODUCTION_DIRECTORY_URL}; only production or localhost`,
    '  --org-credential <file>    org API key file (claim JSON with apiKey, or plain text); or env BEAM_ORG_API_KEY',
    '  --admin-token-file <file>  operator session token; or env BEAM_ADMIN_TOKEN (KYC step only)',
    '  --issuer-public-key <b64>  directory key to verify against; default is the pinned production key',
    '  --offline                  dry run without any HTTP call (assumes nothing exists yet)',
    '  --replace-person-key       allow replacing an existing, different person key (resets KYC)',
    '  --issue-tag <tag>          appended to mandate ids, to re-issue on the same day after a revoke',
    '  --apply                    send the write calls; without it nothing is written',
  ].join('\n')
}

async function main(argv) {
  const command = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'run'
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }
  if (command === 'keygen') {
    const out = optionalFlag('--out')
    if (!out) fail('keygen needs --out <file outside the repository>')
    const created = generatePersonKeyFile(out)
    console.log(`[coppen-trust-chain] wrote ${created.path} (mode 600)`)
    console.log(`  public key:  ${created.publicKey}`)
    console.log(`  fingerprint: ${created.fingerprint}`)
    console.log('  The private key is only in that file. Do not copy, mail or commit it.')
    return 0
  }
  if (command !== 'run' && command !== 'revoke') fail(`Unknown command ${command}\n${usage()}`)

  const configPath = optionalFlag('--config')
  const keyPath = optionalFlag('--key')
  if (!configPath || !keyPath) fail(`--config and --key are required\n${usage()}`)
  const rawConfig = JSON.parse(readFileSync(path.resolve(configPath), 'utf8'))
  const config = parseConfig(rawConfig)
  const key = loadPersonKey(keyPath)
  const directoryUrl = optionalFlag('--directory-url') ?? rawConfig.directoryUrl ?? PRODUCTION_DIRECTORY_URL
  const orgCredential = optionalFlag('--org-credential')
  const adminTokenFile = optionalFlag('--admin-token-file')
  const orgApiKey = orgCredential ? readSecretFile(orgCredential) : (process.env.BEAM_ORG_API_KEY ?? '').trim()
  const adminToken = adminTokenFile ? readSecretFile(adminTokenFile) : (process.env.BEAM_ADMIN_TOKEN ?? '').trim()
  const apply = argv.includes('--apply')

  if (command === 'revoke') {
    const beamId = (optionalFlag('--agent') ?? '').toLowerCase()
    const jti = optionalFlag('--jti') ?? ''
    const result = await runRevoke({ config, key, directoryUrl, beamId, jti, personId: optionalFlag('--person-id') ?? '', apply, orgApiKey })
    return result.ok ? 0 : 1
  }

  const result = await runTrustChain({
    config,
    key,
    directoryUrl,
    apply,
    offline: argv.includes('--offline'),
    replacePersonKey: argv.includes('--replace-person-key'),
    orgApiKey,
    adminToken,
    issuerPublicKey: optionalFlag('--issuer-public-key') ?? '',
    issueTag: optionalFlag('--issue-tag') ?? '',
  })
  return !apply || result.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv).then((code) => {
    process.exitCode = code
  }, (error) => {
    console.error(`[coppen-trust-chain] ${error instanceof TrustChainError ? error.message : error?.stack ?? error}`)
    process.exitCode = 1
  })
}
