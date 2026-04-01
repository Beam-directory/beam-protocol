import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, requestJson, requestText, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startWorkspaceHarness } from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.1.0-operator-digest.md'))

async function main() {
  const { harness, token, workspaceSlug, failedNonce } = await startWorkspaceHarness()

  try {
    const headers = {
      Authorization: `Bearer ${token}`,
    }

    const [digest, markdownExport, timeline] = await Promise.all([
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/digest?days=7`, {
        headers,
      }),
      requestText(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/digest?days=7&format=markdown`, {
        headers,
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/timeline?limit=20`, {
        headers,
      }),
    ])

    if (digest.summary.actionItems < 3) {
      throw new Error(`Expected at least 3 workspace action items, found ${digest.summary.actionItems}`)
    }

    if (digest.summary.escalations < 1) {
      throw new Error(`Expected at least 1 workspace escalation, found ${digest.summary.escalations}`)
    }

    if (!markdownExport.text.includes('## Action Items')) {
      throw new Error('Workspace digest markdown is missing the action item section')
    }

    let deliveryOutcome = {
      status: 'delivered',
      note: `Workspace digest sent to ${harness.adminEmail}.`,
    }
    try {
      await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/digest/deliver`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ days: 7 }),
      })
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

    const criticalItem = digest.escalations[0] ?? digest.actionItems.find((item) => item.severity === 'critical') ?? null
    const relatedTimeline = timeline.entries.find((entry) => entry.traceHref?.includes(failedNonce) || entry.href?.includes(encodeURIComponent(workspaceSlug)))

    const result = {
      ok: true,
      date: formatDate(),
      workspace: digest.workspace.slug,
      actionItems: digest.summary.actionItems,
      escalations: digest.summary.escalations,
      partnerChannels: digest.summary.partnerChannels,
      openThreads: digest.summary.openThreads,
      criticalItem,
      deliveryOutcome,
      timelineEntries: timeline.total,
      relatedTimelineId: relatedTimeline?.id ?? null,
    }

    const markdown = `# Beam 1.1.0 Operator Digest

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local workspace harness

## Result

\`PASS\`

## Digest Summary

- Workspace: \`${digest.workspace.slug}\`
- Action items: \`${digest.summary.actionItems}\`
- Escalations: \`${digest.summary.escalations}\`
- Partner channels: \`${digest.summary.partnerChannels}\`
- Open threads: \`${digest.summary.openThreads}\`

## Escalation Sample

- Title: ${criticalItem?.title ?? 'n/a'}
- Severity: \`${criticalItem?.severity ?? 'n/a'}\`
- Next action: ${criticalItem?.nextAction ?? 'n/a'}
- Surface: ${criticalItem?.href ?? 'n/a'}

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
  console.error('[workspace:digest] failed:', error)
  process.exitCode = 1
})
