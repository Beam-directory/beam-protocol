#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BeamClient } from '../packages/sdk-typescript/dist/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const IDENTITIES_PATH = process.env.BEAM_IDENTITIES || resolve(
  process.env.HOME || '',
  '.openclaw/workspace/secrets/beam-identities.json'
)
const CATALOG_PATH = resolve(__dirname, '../intents/catalog.yaml')

function usage() {
  console.error('Usage: node beam-send-v2.js --from <agent> (--to <agent> | --broadcast) --intent <intent> [--params <json>] [--timeout <ms>]')
}

function parseArgs(argv) {
  const parsed = { broadcast: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'broadcast') {
      parsed.broadcast = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    parsed[key] = value
    i++
  }
  return parsed
}

function loadCatalog() {
  const raw = readFileSync(CATALOG_PATH, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Catalog at ${CATALOG_PATH} must be JSON-compatible YAML`)
  }

  if (!parsed || !Array.isArray(parsed.intents)) {
    throw new Error('Catalog file missing intents array')
  }

  const byId = new Map()
  for (const intent of parsed.intents) {
    if (intent && typeof intent.id === 'string') byId.set(intent.id, intent)
  }
  return byId
}

function ensureObject(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object`)
  }
}

function validateParams(intentDef, params) {
  ensureObject(params, 'params')

  const output = { ...params }
  const schema = intentDef.params || {}

  for (const [key, rules] of Object.entries(schema)) {
    const hasValue = Object.prototype.hasOwnProperty.call(output, key)

    if (!hasValue && Object.prototype.hasOwnProperty.call(rules, 'default')) {
      output[key] = rules.default
    }

    if (!hasValue && rules.required === true) {
      throw new Error(`Missing required param: ${key}`)
    }

    if (!Object.prototype.hasOwnProperty.call(output, key)) continue
    const value = output[key]

    if (rules.type && !matchesType(value, rules.type)) {
      throw new Error(`Param ${key} must be type ${rules.type}`)
    }

    if (Array.isArray(rules.enum) && !rules.enum.includes(value)) {
      throw new Error(`Param ${key} must be one of: ${rules.enum.join(', ')}`)
    }
  }

  return output
}

function matchesType(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (type === 'array') return Array.isArray(value)
  return true
}

function validateParticipants(intentDef, from, to, isBroadcast) {
  const allowedFrom = Array.isArray(intentDef.from) ? intentDef.from : ['*']
  const allowedTo = Array.isArray(intentDef.to) ? intentDef.to : ['*']

  if (!allowedFrom.includes('*') && !allowedFrom.includes(from)) {
    throw new Error(`Sender ${from} is not allowed for intent ${intentDef.id}`)
  }

  if (isBroadcast) {
    if (intentDef.id !== 'system.broadcast') {
      throw new Error('--broadcast is only supported for system.broadcast')
    }
    if (!allowedTo.includes('*')) {
      throw new Error(`Intent ${intentDef.id} does not allow wildcard recipients`)
    }
    return
  }

  if (!to) {
    throw new Error('--to is required unless --broadcast is used')
  }

  if (!allowedTo.includes('*') && !allowedTo.includes(to)) {
    throw new Error(`Recipient ${to} is not allowed for intent ${intentDef.id}`)
  }
}

function formatValue(value) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

async function sendOne({ client, from, to, intent, params, timeoutMs }) {
  const toBeamId = `${to}@coppen.beam.directory`
  const started = Date.now()

  try {
    const response = await client.send(toBeamId, intent, params, timeoutMs)
    return {
      to,
      ok: Boolean(response?.success),
      ms: Date.now() - started,
      response,
    }
  } catch (err) {
    return {
      to,
      ok: false,
      ms: Date.now() - started,
      response: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function printResults(results) {
  console.log('\nResults')
  console.log('target\tsuccess\tlatencyMs\tmessage')
  for (const item of results) {
    const msg = item.error || item.response?.error || item.response?.payload || ''
    console.log(`${item.to}\t${item.ok ? 'yes' : 'no'}\t${item.ms}\t${formatValue(msg)}`)
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    usage()
    process.exit(1)
  }

  const from = args.from
  const to = args.to
  const intentId = args.intent
  const timeoutMs = Number(args.timeout || 60_000)

  if (!from || !intentId) {
    usage()
    process.exit(1)
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error('--timeout must be a positive number in milliseconds')
    process.exit(1)
  }

  const identities = JSON.parse(readFileSync(IDENTITIES_PATH, 'utf8'))
  const fromIdentity = identities[from]
  if (!fromIdentity) {
    console.error(`Identity not found: ${from}`)
    console.error(`Available: ${Object.keys(identities).join(', ')}`)
    process.exit(1)
  }

  const catalog = loadCatalog()
  const intentDef = catalog.get(intentId)
  if (!intentDef) {
    console.error(`Unknown intent: ${intentId}`)
    process.exit(1)
  }

  let params = {}
  if (args.params) {
    try {
      params = JSON.parse(args.params)
    } catch (err) {
      console.error(`Invalid JSON in --params: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  try {
    validateParticipants(intentDef, from, to, args.broadcast)
    params = validateParams(intentDef, params)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const targets = args.broadcast
    ? Object.keys(identities).filter((name) => name !== from)
    : [to]

  if (targets.length === 0) {
    console.error('No recipients found')
    process.exit(1)
  }

  const client = new BeamClient({
    identity: fromIdentity,
    directoryUrl: DIRECTORY_URL,
  })

  const startedAll = Date.now()
  try {
    await client.connect()
    const results = []
    for (const target of targets) {
      results.push(await sendOne({
        client,
        from,
        to: target,
        intent: intentId,
        params,
        timeoutMs,
      }))
    }

    printResults(results)
    const successCount = results.filter((r) => r.ok).length
    console.log(`\nSummary: ${successCount}/${results.length} successful in ${Date.now() - startedAll}ms`)

    if (successCount !== results.length) {
      process.exitCode = 1
    }
  } finally {
    client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
