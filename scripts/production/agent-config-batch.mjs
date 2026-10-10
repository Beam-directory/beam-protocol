#!/usr/bin/env node

// Signed config PATCH and key rotation for a list of existing agents.
// Dry-run by default. Writes happen only with --apply and a --directory-url.
// Private keys are read from operator-supplied paths and never printed.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { canonicalize, signedAgentConfigBody } from './agent-config.mjs'

const BEAM_ID_RE = /^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/
const ROW_FIELDS = ['beamId', 'keyPath', 'newKeyPath', 'httpEndpoint', 'dhPublicKey', 'dhPublicKeyPath']

export function parseInput(text, format) {
  if (format === 'json') {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : parsed?.agents
    if (!Array.isArray(rows)) throw new Error('JSON input must be an array or { "agents": [...] }')
    return rows.map((row) => normalizeRow(row))
  }
  if (format === 'csv') {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    if (lines.length === 0) return []
    if (lines.some((line) => line.includes('"'))) throw new Error('CSV input must not use quotes')
    const header = lines[0].split(',').map((cell) => cell.trim())
    const unknown = header.filter((name) => !ROW_FIELDS.includes(name))
    if (unknown.length > 0) throw new Error(`Unknown CSV columns: ${unknown.join(', ')}`)
    return lines.slice(1).map((line) => {
      const cells = line.split(',').map((cell) => cell.trim())
      return normalizeRow(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])))
    })
  }
  throw new Error('format must be json or csv')
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each agent entry must be an object')
  const out = {}
  for (const field of ROW_FIELDS) {
    const value = typeof row[field] === 'string' ? row[field].trim() : ''
    if (value) out[field] = value
  }
  return out
}

export function loadEd25519PrivateKey(filePath) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8').trim()
  } catch {
    throw new Error(`cannot read key file ${filePath}`)
  }
  let key
  try {
    key = raw.includes('-----BEGIN')
      ? createPrivateKey(raw)
      : createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    throw new Error(`key file ${filePath} is not a PKCS8 private key (base64 DER or PEM)`)
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`key file ${filePath} is not an Ed25519 key`)
  }
  return key
}

function publicKeyBase64(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
}

function isX25519Spki(value) {
  try {
    return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'x25519'
  } catch {
    return false
  }
}

function agentUrl(directoryUrl, beamId, suffix) {
  const base = directoryUrl ? directoryUrl.replace(/\/+$/, '') : '$BEAM_DIRECTORY_URL'
  return `${base}/agents/${encodeURIComponent(beamId)}${suffix}`
}

async function activeDirectoryKey(fetchImpl, directoryUrl, beamId) {
  const response = await fetchImpl(agentUrl(directoryUrl, beamId, '/keys'))
  if (!response.ok) return { error: `GET /keys answered ${response.status}` }
  const body = await response.json()
  return { publicKey: body?.keyState?.active?.publicKey ?? null }
}

// Builds the plan without signing anything. Key objects stay in `keys` and
// are never part of the printable plan.
export async function planBatch(rows, { baseDir = process.cwd(), directoryUrl = null, fetchImpl = fetch } = {}) {
  const plan = []
  const keys = new Map()
  const seen = new Set()
  for (const row of rows) {
    const beamId = row.beamId ?? ''
    const errors = []
    const entry = { beamId, status: 'planned', errors, currentPublicKey: null, patch: null, rotation: null }
    plan.push(entry)

    if (!BEAM_ID_RE.test(beamId)) errors.push('beamId is not a valid Beam ID')
    if (seen.has(beamId)) errors.push('beamId appears more than once')
    seen.add(beamId)

    let currentKey = null
    if (!row.keyPath) {
      errors.push('keyPath is required')
    } else {
      try {
        currentKey = loadEd25519PrivateKey(path.resolve(baseDir, row.keyPath))
        entry.currentPublicKey = publicKeyBase64(currentKey)
      } catch (error) {
        errors.push(error.message)
      }
    }

    const fields = {}
    if (row.httpEndpoint) {
      try {
        if (new URL(row.httpEndpoint).protocol !== 'https:') errors.push('httpEndpoint must use https')
      } catch {
        errors.push('httpEndpoint is not a URL')
      }
      fields.httpEndpoint = row.httpEndpoint
    }
    if (row.dhPublicKey && row.dhPublicKeyPath) errors.push('use dhPublicKey or dhPublicKeyPath, not both')
    let dhPublicKey = row.dhPublicKey ?? null
    if (row.dhPublicKeyPath) {
      try {
        dhPublicKey = readFileSync(path.resolve(baseDir, row.dhPublicKeyPath), 'utf8').trim()
      } catch {
        errors.push(`cannot read dhPublicKeyPath ${row.dhPublicKeyPath}`)
      }
    }
    if (dhPublicKey) {
      if (!isX25519Spki(dhPublicKey)) errors.push('dhPublicKey must be an X25519 SPKI key (base64 DER)')
      fields.dhPublicKey = dhPublicKey
    }
    if (Object.keys(fields).length > 0) {
      entry.patch = { method: 'PATCH', url: agentUrl(directoryUrl, beamId, '/config'), fields, signedBy: 'current key' }
    }

    let nextKey = null
    if (row.newKeyPath) {
      try {
        nextKey = loadEd25519PrivateKey(path.resolve(baseDir, row.newKeyPath))
        const newPublicKey = publicKeyBase64(nextKey)
        if (newPublicKey === entry.currentPublicKey) errors.push('newKeyPath holds the current key')
        entry.rotation = { method: 'POST', url: agentUrl(directoryUrl, beamId, '/keys/rotate'), newPublicKey, signedBy: 'current key' }
      } catch (error) {
        errors.push(error.message.replace('key file', 'new key file'))
      }
    }

    if (!entry.patch && !entry.rotation && !row.newKeyPath) errors.push('nothing to do: give httpEndpoint, dhPublicKey or newKeyPath')

    if (directoryUrl && entry.currentPublicKey && errors.length === 0) {
      try {
        const remote = await activeDirectoryKey(fetchImpl, directoryUrl, beamId)
        if (remote.error) errors.push(`directory check failed: ${remote.error}`)
        else if (remote.publicKey !== entry.currentPublicKey) errors.push('keyPath does not match the active key in the directory')
      } catch (error) {
        errors.push(`directory check failed: ${error.message}`)
      }
    }

    if (errors.length > 0) entry.status = 'invalid'
    if (currentKey) keys.set(beamId, currentKey)
  }
  return { plan, keys }
}

export function signedRotationBody(privateKey, beamId, newPublicKey, timestamp = new Date().toISOString()) {
  const payload = { action: 'keys.rotate', beamId, newPublicKey, timestamp }
  const signature = sign(null, Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8'), privateKey).toString('base64')
  return { new_public_key: newPublicKey, timestamp, signature }
}

async function send(fetchImpl, url, method, body) {
  const response = await fetchImpl(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let errorCode = null
  try {
    errorCode = JSON.parse(text)?.errorCode ?? null
  } catch {
    // Non-JSON error bodies are reported by status only.
  }
  return { status: response.status, ok: response.ok, errorCode }
}

// Applies the plan in order and stops at the first failure so a bad input
// cannot cascade across all agents.
export async function applyBatch({ plan, keys }, { directoryUrl, fetchImpl = fetch }) {
  if (!directoryUrl) throw new Error('--directory-url is required with --apply')
  if (plan.some((entry) => entry.status !== 'planned')) throw new Error('refusing to apply: the plan has invalid entries')
  let stopped = false
  for (const entry of plan) {
    if (stopped) {
      entry.status = 'skipped'
      continue
    }
    const privateKey = keys.get(entry.beamId)
    const remote = await activeDirectoryKey(fetchImpl, directoryUrl, entry.beamId)
    if (remote.error || remote.publicKey !== entry.currentPublicKey) {
      entry.status = 'failed'
      entry.errors.push(remote.error ?? 'keyPath does not match the active key in the directory')
      stopped = true
      continue
    }
    if (entry.patch) {
      const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
      const result = await send(fetchImpl, entry.patch.url, 'PATCH', signedAgentConfigBody(der, entry.beamId, entry.patch.fields))
      entry.patch.result = result
      if (!result.ok) {
        entry.status = 'failed'
        entry.errors.push(`PATCH /config answered ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}`)
        stopped = true
        continue
      }
    }
    if (entry.rotation) {
      const result = await send(
        fetchImpl,
        entry.rotation.url,
        'POST',
        signedRotationBody(privateKey, entry.beamId, entry.rotation.newPublicKey),
      )
      entry.rotation.result = result
      if (!result.ok) {
        entry.status = 'failed'
        entry.errors.push(`POST /keys/rotate answered ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}`)
        stopped = true
        continue
      }
    }
    entry.status = 'applied'
  }
  return plan
}

export function summarize(plan, { mode, directoryUrl }) {
  const count = (status) => plan.filter((entry) => entry.status === status).length
  return {
    mode,
    directoryUrl: directoryUrl ?? null,
    generatedAt: new Date().toISOString(),
    total: plan.length,
    planned: count('planned'),
    invalid: count('invalid'),
    applied: count('applied'),
    failed: count('failed'),
    skipped: count('skipped'),
    agents: plan,
  }
}

export function renderText(summary) {
  const lines = []
  lines.push(`agent-config-batch: ${summary.mode === 'apply' ? 'APPLY' : 'DRY RUN (no requests with write effects)'}`)
  lines.push(`directory: ${summary.directoryUrl ?? 'not set (no remote key check)'}`)
  lines.push('')
  for (const entry of summary.agents) {
    lines.push(`[${entry.status}] ${entry.beamId || '(missing beamId)'}`)
    if (entry.currentPublicKey) lines.push(`  current public key: ${entry.currentPublicKey}`)
    if (entry.patch) {
      lines.push(`  ${entry.patch.method} ${entry.patch.url}`)
      for (const [field, value] of Object.entries(entry.patch.fields)) lines.push(`    ${field}: ${value}`)
      lines.push('    signed with the current key at apply time (type agent.config, fresh timestamp and nonce)')
      if (entry.patch.result) lines.push(`    result: ${entry.patch.result.status}`)
    }
    if (entry.rotation) {
      lines.push(`  ${entry.rotation.method} ${entry.rotation.url}`)
      lines.push(`    new_public_key: ${entry.rotation.newPublicKey}`)
      lines.push('    signed with the current key at apply time (action keys.rotate)')
      if (entry.rotation.result) lines.push(`    result: ${entry.rotation.result.status}`)
    }
    for (const error of entry.errors) lines.push(`  error: ${error}`)
  }
  lines.push('')
  lines.push(`total ${summary.total} | planned ${summary.planned} | invalid ${summary.invalid} | applied ${summary.applied} | failed ${summary.failed} | skipped ${summary.skipped}`)
  if (summary.mode === 'dry-run') {
    lines.push(summary.invalid > 0
      ? 'Fix the invalid entries first. --apply refuses to run while any entry is invalid.'
      : 'Nothing was sent. Re-run with --apply --directory-url <url> to send these requests.')
  } else if (summary.applied > 0) {
    lines.push('Rotated agents must now use their new private key. The old key stops working for signatures.')
  }
  return lines.join('\n')
}

function flag(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, stdout = process.stdout } = {}) {
  const input = flag(argv, '--input')
  if (!input) throw new Error('--input <agents.json|agents.csv> is required')
  const format = flag(argv, '--format') ?? (input.endsWith('.csv') ? 'csv' : 'json')
  const directoryUrl = flag(argv, '--directory-url')
  const apply = argv.includes('--apply')
  const expect = flag(argv, '--expect')

  const rows = parseInput(readFileSync(input, 'utf8'), format)
  if (expect !== null && rows.length !== Number(expect)) {
    throw new Error(`--expect ${expect} but the input has ${rows.length} agents`)
  }
  const built = await planBatch(rows, { baseDir: path.dirname(path.resolve(input)), directoryUrl, fetchImpl })
  if (apply) await applyBatch(built, { directoryUrl, fetchImpl })
  const summary = summarize(built.plan, { mode: apply ? 'apply' : 'dry-run', directoryUrl })

  stdout.write(`${renderText(summary)}\n`)
  const jsonPath = flag(argv, '--json')
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  const failed = summary.invalid + summary.failed
  return failed > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(`[agent-config-batch] ${error.message}`)
      process.exitCode = 1
    },
  )
}
