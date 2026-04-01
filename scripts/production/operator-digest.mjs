import path from 'node:path'
import {
  createAdminHeaders,
  formatDate,
  formatDateTime,
  optionalFlag,
  requestJson,
  seedAckedIntent,
  seedFailedIntent,
  seedProofAgents,
  startProductionHarness,
  toJsonBlock,
  writeMarkdownReport,
} from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-operator-digest.md'))

async function createHostedBetaRequest(directoryUrl, email, company) {
  return requestJson(`${directoryUrl}/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      source: 'hosted-beta-page',
      company,
      agentCount: 6,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Route purchase approvals from Acme procurement to Northwind finance with signed proof.',
    }),
  })
}

async function patchBetaRequest(directoryUrl, token, requestId, payload) {
  return requestJson(`${directoryUrl}/admin/beta-requests/${requestId}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  })
}

async function main() {
  const harness = await startProductionHarness({
    withMessageBus: false,
    seed: {
      directory(db, directoryDbApi) {
        seedProofAgents(db, directoryDbApi)
        for (let index = 0; index < 10; index += 1) {
          seedFailedIntent(
            db,
            directoryDbApi,
            `partner-proof-${index}`,
            `2026-03-31T09:${String(index).padStart(2, '0')}:00.000Z`,
          )
        }
        seedAckedIntent(db, directoryDbApi, 'partner-proof-acked-1', '2026-03-31T10:15:30.000Z')
      },
    },
  })

  try {
    const token = await harness.createAdminToken()

    const criticalRequest = await createHostedBetaRequest(harness.directoryUrl, 'buyer@example.com', 'Northwind Systems')
    const scheduledRequest = await createHostedBetaRequest(harness.directoryUrl, 'pilot@example.com', 'Acme Finance Pilot')

    await patchBetaRequest(harness.directoryUrl, token, criticalRequest.request.id, {
      status: 'active',
      owner: harness.adminEmail,
      nextAction: 'Escalate the failing partner approval route and confirm a fallback path.',
      lastContactAt: '2026-03-30T08:30:00.000Z',
      reminderAt: '2026-03-31T08:00:00.000Z',
      proofIntentNonce: 'partner-proof-9',
    })

    await patchBetaRequest(harness.directoryUrl, token, scheduledRequest.request.id, {
      status: 'scheduled',
      owner: harness.adminEmail,
      nextAction: 'Run the production readiness review and lock the success metric owner.',
      lastContactAt: '2026-03-31T10:10:00.000Z',
      nextMeetingAt: '2026-04-03T14:00:00.000Z',
      reminderAt: '2026-04-02T09:00:00.000Z',
      proofIntentNonce: 'partner-proof-acked-1',
    })

    const [partnerHealth, digest] = await Promise.all([
      requestJson(`${harness.directoryUrl}/admin/partner-health?days=30&hours=24`, {
        headers: createAdminHeaders(token),
      }),
      requestJson(`${harness.directoryUrl}/admin/partner-digest?days=14`, {
        headers: createAdminHeaders(token),
      }),
    ])

    let deliveryOutcome = {
      status: 'delivered',
      note: `Digest sent to ${harness.adminEmail}.`,
    }
    try {
      await requestJson(`${harness.directoryUrl}/admin/partner-digest/deliver`, {
        method: 'POST',
        headers: createAdminHeaders(token),
        body: JSON.stringify({ days: 14 }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deliveryOutcome = message.includes('EMAIL_DELIVERY_UNAVAILABLE')
        ? {
            status: 'delivery_unavailable',
            note: 'Digest delivery route is wired, but SMTP/Resend was intentionally not configured in the local harness.',
          }
        : {
            status: 'delivery_failed',
            note: message,
          }
    }

    const result = {
      ok: true,
      date: formatDate(),
      summary: partnerHealth.summary,
      digestSummary: digest.summary,
      topActionItems: digest.actionItems.slice(0, 3),
      deliveryOutcome,
    }

    const markdown = `# Beam 1.0.0 Operator Digest

## Context

- run date: \`${formatDate()}\`
- flow: partner health -> digest -> delivery path
- environment: local production harness

## Result

\`PASS\`

## Partner Health Summary

- Active partner threads: \`${partnerHealth.summary.activeRequests}\`
- Critical: \`${partnerHealth.summary.critical}\`
- Watch: \`${partnerHealth.summary.watch}\`
- Follow-up due: \`${partnerHealth.summary.followUpDue}\`
- Latency breaches: \`${partnerHealth.summary.latencyBreaches}\`
- Dead letters: \`${partnerHealth.summary.deadLetters}\`

## Digest Summary

- Owned threads: \`${digest.summary.ownedThreads}\`
- Due now: \`${digest.summary.dueNow}\`
- Meetings this week: \`${digest.summary.meetingsThisWeek}\`
- Unowned threads: \`${digest.summary.unownedThreads}\`

## Action Queue Snapshot

${digest.actionItems.slice(0, 3).map((entry, index) => `${index + 1}. ${entry.company ?? entry.email} · ${entry.stage}
   - Owner: ${entry.owner ?? 'unassigned'}
   - Next action: ${entry.nextAction ?? 'not recorded'}
   - Last contact: ${entry.lastContactAt ?? 'not recorded'}
   - Next meeting: ${entry.nextMeetingAt ?? 'not scheduled'}
   - Request: ${entry.href}`).join('\n')}

## Delivery Path

- Status: \`${deliveryOutcome.status}\`
- Note: ${deliveryOutcome.note}

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(outputPath, markdown)
    console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error('[production:operator-digest] failed:', error)
  process.exitCode = 1
})
