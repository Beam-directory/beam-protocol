import path from 'node:path'
import {
  createAdminHeaders,
  formatDate,
  formatDateTime,
  optionalFlag,
  requestJson,
  requestText,
  seedFailedIntent,
  seedProofAgents,
  startProductionHarness,
  toJsonBlock,
  writeMarkdownReport,
} from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-fire-drill.md'))

async function createHostedBetaRequest(directoryUrl) {
  return requestJson(`${directoryUrl}/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'incident@example.com',
      source: 'hosted-beta-page',
      company: 'Northwind Incident Pilot',
      agentCount: 8,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Simulate a production partner incident and verify the operator path is explicit.',
    }),
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
            `fire-drill-proof-${index}`,
            `2026-03-31T11:${String(index).padStart(2, '0')}:00.000Z`,
          )
        }
      },
    },
  })

  try {
    const token = await harness.createAdminToken()
    const created = await createHostedBetaRequest(harness.directoryUrl)

    await requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: createAdminHeaders(token),
      body: JSON.stringify({
        status: 'active',
        owner: harness.adminEmail,
        nextAction: 'Open the latest failing trace and decide whether to pause the rollout.',
        lastContactAt: '2026-03-31T10:00:00.000Z',
        reminderAt: '2026-03-31T10:30:00.000Z',
        proofIntentNonce: 'fire-drill-proof-9',
      }),
    })

    const [alerts, partnerHealth, detail] = await Promise.all([
      requestJson(`${harness.directoryUrl}/observability/alerts?hours=24`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/partner-health?days=30&hours=24`, {
        headers: createAdminHeaders(token),
      }),
      requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ])

    const proofPackMarkdown = await requestText(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}/proof-pack?format=markdown`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    const linkedAlert = alerts.alerts.find((entry) => (entry.relatedPartnerRequests ?? []).some((request) => request.id === created.request.id))
    if (!linkedAlert) {
      throw new Error('No alert linked back to the affected partner request during the fire drill.')
    }

    const incident = partnerHealth.incidents.find((entry) => entry.requestId === created.request.id)
    if (!incident) {
      throw new Error('Partner health did not expose the fire-drill request as an incident.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      requestId: created.request.id,
      alertId: linkedAlert.id,
      incidentTitle: incident.title,
      requestStage: detail.request.stage,
      proofIntentNonce: detail.request.proofIntentNonce,
      proofSummaryHeadline: detail.proofSummary?.headline ?? null,
    }

    const markdown = `# Beam 1.0.0 Fire Drill

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local production harness

## Result

\`PASS\`

## Scenario

1. Seeded a partner workflow with ten failing proof traces so the operator surfaces would raise a real alert.
2. Bound the newest failing nonce to one active hosted-beta request with an overdue reminder.
3. Opened the alert path, partner-health path, beta-request detail, and proof-pack export for the same request.

## Verification

- Linked alert: \`${linkedAlert.id}\`
- Partner-health incident: \`${incident.title}\`
- Request stage during drill: \`${detail.request.stage}\`
- Proof nonce: \`${detail.request.proofIntentNonce}\`
- Proof pack export status: \`${proofPackMarkdown.response.status}\`

## Proof Pack Preview

\`\`\`md
${proofPackMarkdown.text.split('\n').slice(0, 18).join('\n')}
\`\`\`

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
  console.error('[production:fire-drill] failed:', error)
  process.exitCode = 1
})
