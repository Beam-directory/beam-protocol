#!/usr/bin/env node
/**
 * beam-send.js — Send a Beam Intent from CLI
 * Usage: node beam-send.js --from jarvis --to clara --intent "sales.report" --params '{"owner":"schnorrenberg"}'
 */

import { BeamIdentity } from '../packages/sdk-typescript/dist/index.js'
import { BeamClient } from '../packages/sdk-typescript/dist/client.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const IDENTITIES_PATH = process.env.BEAM_IDENTITIES || resolve(
  process.env.HOME, '.openclaw/workspace/secrets/beam-identities.json'
)

function parseArgs() {
  const args = process.argv.slice(2)
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    parsed[key] = args[i + 1]
  }
  return parsed
}

async function main() {
  const args = parseArgs()
  
  if (!args.from || !args.to || !args.intent) {
    console.error('Usage: beam-send.js --from <agent> --to <agent> --intent <intent> [--params <json>]')
    process.exit(1)
  }

  // Load identities
  const identities = JSON.parse(readFileSync(IDENTITIES_PATH, 'utf8'))
  const fromId = identities[args.from]
  if (!fromId) {
    console.error(`Identity not found: ${args.from}`)
    console.error(`Available: ${Object.keys(identities).join(', ')}`)
    process.exit(1)
  }

  const toBeamId = `${args.to}@coppen.beam.directory`
  const params = args.params ? JSON.parse(args.params) : {}

  // Create client and send
  const client = new BeamClient({
    identity: fromId,
    directoryUrl: DIRECTORY_URL
  })

  await client.connect()
  
  console.log(`📤 Sending intent "${args.intent}" from ${args.from} to ${args.to}`)
  console.log(`   Params: ${JSON.stringify(params)}`)
  
  const result = await client.send(toBeamId, args.intent, params, 30000)
  
  console.log(`\n📬 Response:`)
  console.log(`   Success: ${result.success}`)
  if (result.payload) console.log(`   Payload: ${JSON.stringify(result.payload, null, 2)}`)
  if (result.error) console.log(`   Error: ${result.error}`)
  
  client.disconnect()
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
