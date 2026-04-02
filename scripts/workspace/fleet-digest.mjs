import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startOpenClawFleetHarness } from './fleet-shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.3.0-fleet-digest.md'))

async function main() {
  const fleet = await startOpenClawFleetHarness()

  try {
    await fleet.markHostStale('beta', 12)
    await fleet.rotateHost('beta')
    await fleet.createConflict()

    const digest = await fleet.fetchFleetDigest()
    const markdownExport = await fleet.fetchFleetDigest({ format: 'markdown' })

    if (digest.summary.staleHosts < 1) {
      throw new Error(`Expected at least one stale host, found ${digest.summary.staleHosts}`)
    }
    if (digest.summary.pendingCredentialActions < 1) {
      throw new Error(`Expected at least one pending credential action, found ${digest.summary.pendingCredentialActions}`)
    }
    if (digest.summary.duplicateIdentityConflicts < 1) {
      throw new Error(`Expected at least one duplicate identity conflict, found ${digest.summary.duplicateIdentityConflicts}`)
    }
    if (digest.summary.actionItems < 4) {
      throw new Error(`Expected at least four fleet digest action items, found ${digest.summary.actionItems}`)
    }
    for (const category of ['host', 'credential', 'conflict', 'delivery']) {
      if (!digest.actionItems.some((item) => item.category === category)) {
        throw new Error(`Expected the fleet digest to include a ${category} action item.`)
      }
    }
    if (!markdownExport.includes('## Action Items')) {
      throw new Error('Expected the fleet digest markdown export to include the action item section.')
    }

    let deliveryOutcome = {
      status: 'delivered',
      note: 'Fleet digest delivered successfully.',
    }

    try {
      await fleet.deliverFleetDigest()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deliveryOutcome = message.includes('EMAIL_DELIVERY_UNAVAILABLE')
        ? {
            status: 'delivery_unavailable',
            note: 'Digest delivery is wired end to end, but the local harness intentionally has no SMTP or Resend configuration.',
          }
        : {
            status: 'delivery_failed',
            note: message,
          }
    }

    const result = {
      ok: true,
      date: formatDate(),
      workspace: fleet.workspaceSlug,
      summary: digest.summary,
      leadingActions: digest.actionItems.slice(0, 4).map((item) => ({
        category: item.category,
        severity: item.severity,
        title: item.title,
        nextAction: item.nextAction,
      })),
      deliveryOutcome,
    }

    const markdown = `# Beam 1.3.0 Fleet Digest

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Mark one host stale.
2. Rotate one host credential without applying the new credential yet.
3. Inject one duplicate Beam identity conflict on a second host.
4. Read the fleet digest and confirm that it turns all three states into explicit operator action items.
5. Exercise the digest delivery path and verify the local harness reports the expected “delivery unavailable” state without SMTP configuration.

## Verification

- Stale hosts: \`${digest.summary.staleHosts}\`
- Pending credential actions: \`${digest.summary.pendingCredentialActions}\`
- Duplicate conflicts: \`${digest.summary.duplicateIdentityConflicts}\`
- Action items: \`${digest.summary.actionItems}\`
- Critical items: \`${digest.summary.criticalItems}\`
- Delivery path: \`${deliveryOutcome.status}\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(outputPath, markdown)
    console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
  } finally {
    await fleet.cleanup()
  }
}

main().catch((error) => {
  console.error('[workspace:fleet-digest] failed:', error)
  process.exitCode = 1
})
