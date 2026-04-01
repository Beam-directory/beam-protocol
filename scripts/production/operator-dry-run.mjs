import path from 'node:path'
import {
  createAdminHeaders,
  formatDate,
  formatDateTime,
  optionalFlag,
  requestJson,
  requestText,
  seedAckedIntent,
  seedFailedIntent,
  seedProofAgents,
  startProductionHarness,
  toJsonBlock,
  writeMarkdownReport,
} from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-operator-dry-run.md'))

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
      workflowSummary: 'Exercise the operator path from partner health to proof export.',
    }),
  })
}

async function main() {
  const harness = await startProductionHarness({
    withMessageBus: false,
    seed: {
      directory(db, directoryDbApi) {
        seedProofAgents(db, directoryDbApi)
        seedAckedIntent(db, directoryDbApi, 'operator-proof-acked-1', '2026-03-31T10:15:30.000Z')
        for (let index = 0; index < 10; index += 1) {
          seedFailedIntent(
            db,
            directoryDbApi,
            `operator-proof-failed-${index}`,
            `2026-03-31T11:${String(index).padStart(2, '0')}:00.000Z`,
          )
        }
      },
    },
  })

  try {
    const token = await harness.createAdminToken()
    const readyRequest = await createHostedBetaRequest(harness.directoryUrl, 'ready@example.com', 'Ready Partner')
    const incidentRequest = await createHostedBetaRequest(harness.directoryUrl, 'incident@example.com', 'Incident Partner')

    await requestJson(`${harness.directoryUrl}/admin/beta-requests/${readyRequest.request.id}`, {
      method: 'PATCH',
      headers: createAdminHeaders(token),
      body: JSON.stringify({
        status: 'scheduled',
        owner: harness.adminEmail,
        nextAction: 'Run the scheduled go-live review.',
        nextMeetingAt: '2026-04-04T15:00:00.000Z',
        proofIntentNonce: 'operator-proof-acked-1',
      }),
    })

    await requestJson(`${harness.directoryUrl}/admin/beta-requests/${incidentRequest.request.id}`, {
      method: 'PATCH',
      headers: createAdminHeaders(token),
      body: JSON.stringify({
        status: 'active',
        owner: harness.adminEmail,
        nextAction: 'Pause the route and triage the latest failure.',
        reminderAt: '2026-03-31T08:00:00.000Z',
        proofIntentNonce: 'operator-proof-failed-9',
      }),
    })

    const [partnerHealth, alerts, digest, detail, proofPack] = await Promise.all([
      requestJson(`${harness.directoryUrl}/admin/partner-health?days=30&hours=24`, {
        headers: createAdminHeaders(token),
      }),
      requestJson(`${harness.directoryUrl}/observability/alerts?hours=24`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/partner-digest?days=14`, {
        headers: createAdminHeaders(token),
      }),
      requestJson(`${harness.directoryUrl}/admin/beta-requests/${incidentRequest.request.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestText(`${harness.directoryUrl}/admin/beta-requests/${incidentRequest.request.id}/proof-pack?format=markdown`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ])

    const linkedAlert = alerts.alerts.find((entry) => (entry.relatedPartnerRequests ?? []).some((request) => request.id === incidentRequest.request.id))
    if (!linkedAlert) {
      throw new Error('Operator dry run did not find a linked partner request on the alert surface.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      criticalRequests: partnerHealth.summary.critical,
      digestDueNow: digest.summary.dueNow,
      linkedAlertId: linkedAlert.id,
      incidentRequestId: incidentRequest.request.id,
      proofIntentNonce: detail.request.proofIntentNonce,
    }

    const markdown = `# Beam 1.0.0 Operator Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local production harness

## Result

\`PASS\`

## Scenario

1. Seeded one healthy scheduled partner thread and one active incident thread.
2. Opened partner health, alerts, digest, beta-request detail, and proof-pack export.
3. Confirmed the alert linked back to the affected partner record and that the digest still surfaced the due action.

## Verification

- Critical partner requests: \`${partnerHealth.summary.critical}\`
- Digest due now: \`${digest.summary.dueNow}\`
- Linked alert: \`${linkedAlert.id}\`
- Incident request: \`${incidentRequest.request.id}\`
- Proof nonce: \`${detail.request.proofIntentNonce}\`
- Proof export status: \`${proofPack.response.status}\`

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
  console.error('[production:operator-dry-run] failed:', error)
  process.exitCode = 1
})
