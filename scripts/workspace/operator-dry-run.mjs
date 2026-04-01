import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, requestJson, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startWorkspaceHarness } from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.1.0-operator-dry-run.md'))

async function main() {
  const {
    harness,
    token,
    workspaceSlug,
    workflowType,
    failedNonce,
    localBindingId,
    partnerBindingId,
    partnerChannelId,
    blockedThreadId,
    linkedThreadId,
  } = await startWorkspaceHarness()

  try {
    const adminHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities/${localBindingId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        canInitiateExternal: true,
        notes: 'Operator approved the runtime for external motion after checking the workflow rule.',
      }),
    })

    await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels/${partnerChannelId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: harness.adminEmail,
        notes: 'Operator assigned the partner channel to the current workspace owner for live follow-up.',
      }),
    })

    await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Invoice appeal blocked draft',
        summary: 'Escalated draft that stays blocked until the approver signs off.',
        owner: harness.adminEmail,
        status: 'blocked',
        workflowType: `${workflowType}.appeal`,
        participants: [
          {
            principalId: 'procurement@acme.beam.directory',
            principalType: 'agent',
            beamId: 'procurement@acme.beam.directory',
            workspaceBindingId: localBindingId,
            role: 'owner',
          },
          {
            principalId: 'finance@northwind.beam.directory',
            principalType: 'partner',
            beamId: 'finance@northwind.beam.directory',
            workspaceBindingId: partnerBindingId,
            role: 'participant',
          },
        ],
      }),
    })

    await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/policy`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        defaults: {
          externalInitiation: 'binding',
          allowedPartners: ['finance@northwind.beam.directory'],
        },
        workflowRules: [
          {
            workflowType,
            requireApproval: true,
            allowedPartners: ['finance@northwind.beam.directory'],
            approvers: [harness.adminEmail],
          },
          {
            workflowType: `${workflowType}.appeal`,
            requireApproval: true,
            allowedPartners: ['finance@northwind.beam.directory'],
            approvers: [harness.adminEmail],
          },
        ],
        metadata: {
          notes: 'Operator verified both the baseline invoice review and the appeal path.',
        },
      }),
    })

    const [overview, identities, channels, threads, blockedThread, linkedThread, policy, timeline, digest] = await Promise.all([
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/overview`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads/${blockedThreadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads/${linkedThreadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/policy`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/timeline?limit=40`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/digest?days=7`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ])

    const localBinding = identities.bindings.find((entry) => entry.id === localBindingId)
    if (!localBinding || localBinding.canInitiateExternal !== true) {
      throw new Error('Workspace operator dry run did not persist the binding approval action.')
    }

    const partnerChannel = channels.channels.find((entry) => entry.id === partnerChannelId)
    if (!partnerChannel || partnerChannel.owner !== harness.adminEmail) {
      throw new Error('Workspace operator dry run did not persist the partner channel owner assignment.')
    }

    if (!linkedThread.thread.trace?.href || !linkedThread.thread.trace.href.includes(failedNonce)) {
      throw new Error('Workspace linked handoff thread detail is missing the Beam trace.')
    }

    if (policy.previews.workflows.length < 2) {
      throw new Error('Workspace policy preview did not include the additional appeal workflow.')
    }

    if (timeline.total < 6) {
      throw new Error(`Expected at least 6 workspace timeline entries, found ${timeline.total}`)
    }

    const result = {
      ok: true,
      date: formatDate(),
      workspace: overview.workspace.slug,
      localBinding: {
        id: localBinding.id,
        canInitiateExternal: localBinding.canInitiateExternal,
        lifecycleStatus: localBinding.lifecycleStatus,
      },
      partnerChannel: {
        id: partnerChannel.id,
        healthStatus: partnerChannel.healthStatus,
        owner: partnerChannel.owner,
      },
      blockedThread: {
        id: blockedThread.thread.id,
        status: blockedThread.thread.status,
        traceHref: blockedThread.thread.trace?.href ?? null,
      },
      linkedThread: {
        id: linkedThread.thread.id,
        status: linkedThread.thread.status,
        traceHref: linkedThread.thread.trace?.href ?? null,
      },
      summary: overview.summary,
      digestSummary: digest.summary,
      policyWorkflows: policy.previews.workflows.map((entry) => entry.workflowType),
      threadCount: threads.total,
      timelineEntries: timeline.total,
    }

    const markdown = `# Beam 1.1.0 Operator Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local workspace harness

## Result

\`PASS\`

## Scenario

1. Approve the local runtime binding for external motion.
2. Assign the blocked partner channel to the current operator.
3. Create a second blocked handoff draft for the appeal path.
4. Patch the workspace policy to cover both workflow variants.
5. Re-open overview, identities, partner channels, thread detail, timeline, and digest.

## Verification

- Local binding external-ready: \`${localBinding.canInitiateExternal}\`
- Partner channel owner: \`${partnerChannel.owner}\`
- Blocked draft status: \`${blockedThread.thread.status}\`
- Linked trace: \`${linkedThread.thread.trace?.href}\`
- Policy workflows: \`${policy.previews.workflows.length}\`
- Timeline entries: \`${timeline.total}\`
- Digest action items: \`${digest.summary.actionItems}\`

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
  console.error('[workspace:operator-dry-run] failed:', error)
  process.exitCode = 1
})
