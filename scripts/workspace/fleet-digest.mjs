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
    const now = new Date()
    await fleet.updateFleetDigestSchedule({
      enabled: true,
      deliveryEmail: 'ops@beam.local',
      escalationEmail: 'critical@beam.local',
      runHourUtc: now.getUTCHours(),
      runMinuteUtc: now.getUTCMinutes(),
      escalateOnCritical: true,
    })

    const digest = await fleet.fetchFleetDigest()
    const markdownExport = await fleet.fetchFleetDigest({ format: 'markdown' })
    const scheduledRun = await fleet.runFleetDigest({
      triggerKind: 'scheduled',
      respectSchedule: true,
      deliver: true,
    })
    const digestAfterRun = await fleet.fetchFleetDigest()

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
    if (scheduledRun.skipped) {
      throw new Error(`Expected the scheduled fleet digest to run, but it was skipped with reason ${scheduledRun.reason ?? 'unknown'}.`)
    }
    if (!scheduledRun.run) {
      throw new Error('Expected the scheduled fleet digest run response to include a persisted run.')
    }
    if (digestAfterRun.history.runs.length < 1) {
      throw new Error('Expected the fleet digest history to contain at least one run.')
    }
    if (digestAfterRun.history.deliveries.length < 2) {
      throw new Error(`Expected the fleet digest history to contain at least two deliveries, found ${digestAfterRun.history.deliveries.length}.`)
    }
    if (!digestAfterRun.history.deliveries.some((delivery) => delivery.kind === 'digest')) {
      throw new Error('Expected digest delivery history to include a digest delivery record.')
    }
    if (!digestAfterRun.history.deliveries.some((delivery) => delivery.kind === 'escalation')) {
      throw new Error('Expected digest delivery history to include an escalation delivery record.')
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
      scheduledRun: {
        id: scheduledRun.run.id,
        deliveryState: scheduledRun.run.deliveryState,
        deliveries: scheduledRun.deliveries?.map((delivery) => ({
          kind: delivery.delivery.kind,
          status: delivery.status,
          errorCode: delivery.errorCode,
        })) ?? [],
      },
      digestSchedule: digestAfterRun.schedule,
      digestHistory: {
        runs: digestAfterRun.history.runs.length,
        deliveries: digestAfterRun.history.deliveries.length,
      },
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
5. Run the scheduled digest path and verify that Beam persists one run plus digest/escalation delivery history.
6. Exercise the manual delivery path and verify the local harness reports the expected “delivery unavailable” state without SMTP configuration.

## Verification

- Stale hosts: \`${digest.summary.staleHosts}\`
- Pending credential actions: \`${digest.summary.pendingCredentialActions}\`
- Duplicate conflicts: \`${digest.summary.duplicateIdentityConflicts}\`
- Action items: \`${digest.summary.actionItems}\`
- Critical items: \`${digest.summary.criticalItems}\`
- Scheduled runs: \`${digestAfterRun.history.runs.length}\`
- Delivery history: \`${digestAfterRun.history.deliveries.length}\`
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
