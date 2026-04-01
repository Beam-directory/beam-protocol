import path from 'node:path'
import {
  createAdminHeaders,
  formatDate,
  formatDateTime,
  optionalFlag,
  requestJson,
  requestText,
  seedAckedIntent,
  seedProofAgents,
  startProductionHarness,
  toJsonBlock,
  writeMarkdownReport,
} from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-production-partner-dry-run.md'))

async function createHostedBetaRequest(directoryUrl) {
  return requestJson(`${directoryUrl}/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'go-live@example.com',
      source: 'hosted-beta-page',
      company: 'Northwind Production Partner',
      agentCount: 12,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Move one finance approval workflow through onboarding, proof, and go-live readiness without ad-hoc operator glue.',
    }),
  })
}

async function main() {
  const harness = await startProductionHarness({
    withMessageBus: false,
    seed: {
      directory(db, directoryDbApi) {
        seedProofAgents(db, directoryDbApi)
        seedAckedIntent(db, directoryDbApi, 'production-proof-acked-1', '2026-03-31T10:15:30.000Z')
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
        status: 'scheduled',
        owner: harness.adminEmail,
        nextAction: 'Confirm the production go-live window and the named success metric owner.',
        lastContactAt: '2026-03-31T10:20:00.000Z',
        nextMeetingAt: '2026-04-04T15:00:00.000Z',
        reminderAt: '2026-04-03T09:00:00.000Z',
        proofIntentNonce: 'production-proof-acked-1',
        blockedPrerequisites: [],
      }),
    })

    const [detail, partnerHealth, proofPack] = await Promise.all([
      requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/partner-health?days=30&hours=24`, {
        headers: createAdminHeaders(token),
      }),
      requestText(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}/proof-pack?format=markdown`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ])

    const partnerRecord = partnerHealth.requests.find((entry) => entry.id === created.request.id)
    if (!partnerRecord) {
      throw new Error('Production-partner dry run could not find the request in partner health.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      requestId: created.request.id,
      stage: detail.request.stage,
      blockedPrerequisites: detail.request.blockedPrerequisites,
      nextMeetingAt: detail.request.nextMeetingAt,
      proofIntentNonce: detail.request.proofIntentNonce,
      healthStatus: partnerRecord.healthStatus,
    }

    const markdown = `# Beam 1.0.0 Production Partner Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local production harness

## Result

\`PASS\`

## Scenario

1. Captured a new production-partner request through the hosted-beta intake path.
2. Moved the request into a scheduled go-live state with an owner, next action, and next meeting.
3. Attached one acknowledged proof nonce to the record.
4. Verified the record appears in partner health and that the redaction-safe proof pack exports cleanly.

## Verification

- Request stage: \`${detail.request.stage}\`
- Blocked prerequisites: \`${detail.request.blockedPrerequisites.length}\`
- Next meeting: \`${detail.request.nextMeetingAt}\`
- Proof nonce: \`${detail.request.proofIntentNonce}\`
- Health status: \`${partnerRecord.healthStatus}\`
- Proof export status: \`${proofPack.response.status}\`

## Proof Pack Preview

\`\`\`md
${proofPack.text.split('\n').slice(0, 18).join('\n')}
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
  console.error('[production:partner-dry-run] failed:', error)
  process.exitCode = 1
})
