#!/usr/bin/env node

import { BeamClient } from '../packages/sdk-typescript/dist/client.js'
import { BeamIdentity } from '../packages/sdk-typescript/dist/identity.js'

const DIRECTORY_URL = process.env.BEAM_DIRECTORY_URL || 'http://localhost:3100'
const TIMEOUT_MS = Number(process.env.BEAM_TEST_TIMEOUT || '60000')

const testCases = [
  {
    intent: 'escalation.request',
    to: 'jarvis',
    params: {
      caseId: 'CASE-2401',
      reason: 'Customer requested executive escalation',
      urgency: 'high',
      customerName: 'Acme GmbH',
    },
  },
  {
    intent: 'payment.status_check',
    to: 'fischer',
    params: {
      projectId: 'PRJ-7788',
      invoiceNumber: 'INV-2026-1042',
      customerName: 'Nova AG',
    },
  },
  {
    intent: 'sales.pipeline_summary',
    to: 'clara',
    params: {
      timeRange: '30d',
      owner: 'jarvis',
    },
  },
]

function printTable(rows) {
  console.log('intent\ttarget\tsuccess\tlatencyMs\tmessage')
  for (const row of rows) {
    console.log(`${row.intent}\t${row.to}\t${row.success ? 'yes' : 'no'}\t${row.latencyMs}\t${row.message}`)
  }
}

async function main() {
  if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
    throw new Error('BEAM_TEST_TIMEOUT must be a positive number')
  }

  const uniqueName = `orchestrator-${Date.now()}`
  const identity = BeamIdentity.generate({
    agentName: uniqueName,
    orgName: 'coppen',
  }).export()

  const client = new BeamClient({
    identity,
    directoryUrl: DIRECTORY_URL,
  })

  const results = []

  try {
    await client.register('Beam v0.2 Test Orchestrator', ['test', 'orchestration'])
    await client.connect()

    for (const testCase of testCases) {
      const started = Date.now()
      try {
        const response = await client.send(
          `${testCase.to}@coppen.beam.directory`,
          testCase.intent,
          testCase.params,
          TIMEOUT_MS
        )

        results.push({
          intent: testCase.intent,
          to: testCase.to,
          success: Boolean(response?.success),
          latencyMs: Date.now() - started,
          message: response?.success
            ? 'ok'
            : (response?.error || 'unknown_error'),
        })
      } catch (err) {
        results.push({
          intent: testCase.intent,
          to: testCase.to,
          success: false,
          latencyMs: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    client.disconnect()
  }

  console.log('\nBeam Chain Test v2 Results')
  printTable(results)

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
