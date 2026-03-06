#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID, createPrivateKey, sign } from 'node:crypto'

const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const IDENTITIES_PATH = process.env.BEAM_IDENTITIES || resolve(
  process.env.HOME || '',
  '.openclaw/workspace/secrets/beam-identities.json'
)

function buildFrame({ from, to, intent, payload, nonce = randomUUID() }) {
  return {
    v: '1',
    from,
    to,
    intent,
    payload,
    nonce,
    timestamp: new Date().toISOString(),
  }
}

function signIntentFrame(frame, privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })

  const signedPayload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  frame.signature = sign(null, Buffer.from(signedPayload, 'utf8'), privateKey).toString('base64')
  return frame
}

async function sendFrame(frame) {
  const started = Date.now()
  const res = await fetch(`${DIRECTORY_URL.replace(/\/$/, '')}/intents/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(frame),
  })

  const body = await res.json().catch(() => ({}))
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    body,
  }
}

function printResults(results) {
  console.log('test\tsuccess\tstatus\tlatencyMs\tmessage')
  for (const row of results) {
    console.log(`${row.name}\t${row.success ? 'yes' : 'no'}\t${row.status}\t${row.ms}\t${row.message}`)
  }
}

async function main() {
  const identities = JSON.parse(readFileSync(IDENTITIES_PATH, 'utf8'))
  const clara = identities.clara
  const fischer = identities.fischer

  if (!clara || !fischer) {
    throw new Error('Missing clara/fischer identities in beam-identities.json')
  }

  const results = []

  // 1) Valid signed intent -> should succeed
  const validFrame = signIntentFrame(buildFrame({
    from: 'clara@coppen.beam.directory',
    to: 'jarvis@coppen.beam.directory',
    intent: 'escalation.request',
    payload: {
      caseId: 'CASE-SEC-001',
      reason: 'Security test valid intent',
      urgency: 'high',
    },
  }), clara.privateKeyBase64)
  const validRes = await sendFrame(validFrame)
  results.push({
    name: 'valid_signed_intent',
    success: validRes.ok && validRes.body?.success === true,
    status: validRes.status,
    ms: validRes.ms,
    message: validRes.ok ? 'ok' : String(validRes.body?.error || 'failed'),
  })

  // 2) Tampered payload (wrong signature) -> should be rejected
  const tamperedFrame = signIntentFrame(buildFrame({
    from: 'clara@coppen.beam.directory',
    to: 'jarvis@coppen.beam.directory',
    intent: 'escalation.request',
    payload: {
      caseId: 'CASE-SEC-002',
      reason: 'Original payload',
      urgency: 'low',
    },
  }), clara.privateKeyBase64)
  tamperedFrame.payload.reason = 'Tampered after signing'
  const tamperedRes = await sendFrame(tamperedFrame)
  results.push({
    name: 'tampered_signature',
    success: !tamperedRes.ok,
    status: tamperedRes.status,
    ms: tamperedRes.ms,
    message: String(tamperedRes.body?.error || 'unexpected_success'),
  })

  // 3) Unauthorized sender (no ACL) -> should be rejected
  const unauthorizedFrame = signIntentFrame(buildFrame({
    from: 'fischer@coppen.beam.directory',
    to: 'jarvis@coppen.beam.directory',
    intent: 'payment.status_check',
    payload: {
      projectId: 'PRJ-SEC-003',
      invoiceNumber: 'INV-SEC-003',
      customerName: 'Unauthorized Test',
    },
  }), fischer.privateKeyBase64)
  const unauthorizedRes = await sendFrame(unauthorizedFrame)
  results.push({
    name: 'unauthorized_acl',
    success: !unauthorizedRes.ok,
    status: unauthorizedRes.status,
    ms: unauthorizedRes.ms,
    message: String(unauthorizedRes.body?.error || 'unexpected_success'),
  })

  // 4) Invalid payload schema -> should be rejected
  const invalidPayloadFrame = signIntentFrame(buildFrame({
    from: 'clara@coppen.beam.directory',
    to: 'jarvis@coppen.beam.directory',
    intent: 'escalation.request',
    payload: {
      reason: 'Missing required caseId',
      urgency: 'critical',
    },
  }), clara.privateKeyBase64)
  const invalidPayloadRes = await sendFrame(invalidPayloadFrame)
  results.push({
    name: 'invalid_payload_schema',
    success: !invalidPayloadRes.ok,
    status: invalidPayloadRes.status,
    ms: invalidPayloadRes.ms,
    message: String(invalidPayloadRes.body?.error || 'unexpected_success'),
  })

  // 5) Replay with same nonce -> second should fail
  const replayNonce = randomUUID()
  const replayFrame = signIntentFrame(buildFrame({
    from: 'clara@coppen.beam.directory',
    to: 'jarvis@coppen.beam.directory',
    intent: 'agent.ping',
    payload: {
      message: 'Replay protection test',
    },
    nonce: replayNonce,
  }), clara.privateKeyBase64)

  const replayFirst = await sendFrame(replayFrame)
  const replaySecond = await sendFrame(replayFrame)
  results.push({
    name: 'replay_protection',
    success: replayFirst.ok && !replaySecond.ok,
    status: replaySecond.status,
    ms: replayFirst.ms + replaySecond.ms,
    message: String(replaySecond.body?.error || 'unexpected_success'),
  })

  console.log('\nBeam Chain Security Test v2 Results')
  printResults(results)

  const passed = results.filter((r) => r.success).length
  console.log(`\nSummary: ${passed}/${results.length} passed`)

  if (passed !== results.length) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
