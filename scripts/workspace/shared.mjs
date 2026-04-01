import {
  createAdminHeaders,
  requestJson,
  seedAckedIntent,
  seedFailedIntent,
  seedProofAgents,
  startProductionHarness,
} from '../production/shared.mjs'

export function minutesAgoIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

export async function startWorkspaceHarness() {
  const failedNonce = 'workspace-control-failed'
  const ackedNonce = 'workspace-control-acked'
  const workspaceSlug = 'acme-finance'
  const workflowType = 'invoice.review'

  const harness = await startProductionHarness({
    withMessageBus: false,
    seed: {
      directory(db, directoryDbApi) {
        seedProofAgents(db, directoryDbApi)
        seedAckedIntent(db, directoryDbApi, ackedNonce, minutesAgoIso(140))
        seedFailedIntent(db, directoryDbApi, failedNonce, minutesAgoIso(35))
      },
    },
  })

  const token = await harness.createAdminToken()
  const adminHeaders = createAdminHeaders(token)

  await requestJson(`${harness.directoryUrl}/admin/workspaces`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Acme Finance',
      slug: workspaceSlug,
      description: 'Workspace control plane for Acme finance approvals and Northwind partner motion.',
      externalHandoffsEnabled: true,
    }),
  })

  const localBinding = await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      beamId: 'procurement@acme.beam.directory',
      bindingType: 'agent',
      owner: harness.adminEmail,
      runtimeType: 'codex:workspace',
      policyProfile: 'finance-outbound',
      canInitiateExternal: false,
      notes: 'Manual review is required until the approval rule is in place.',
    }),
  })

  const partnerBinding = await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      beamId: 'finance@northwind.beam.directory',
      bindingType: 'partner',
      owner: 'northwind@example.com',
      policyProfile: 'partner-finance',
      notes: 'Primary partner finance receiver.',
    }),
  })

  const partnerChannel = await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      partnerBeamId: 'finance@northwind.beam.directory',
      label: 'Northwind Finance',
      owner: 'northwind@example.com',
      status: 'blocked',
      notes: 'Blocked until operator approval is recorded for the workflow.',
    }),
  })

  await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels/${partnerChannel.channel.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({
      lastIntentNonce: failedNonce,
      lastFailureAt: minutesAgoIso(30),
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
      ],
      metadata: {
        notes: 'Invoice review requires an operator approval before the runtime is allowed to send outward.',
      },
    }),
  })

  await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      kind: 'internal',
      title: 'Collect invoice proof',
      summary: 'Gather operator evidence before external motion.',
      owner: harness.adminEmail,
      participants: [
        {
          principalId: harness.adminEmail,
          principalType: 'human',
          displayName: 'Workspace operator',
          role: 'owner',
        },
        {
          principalId: 'procurement@acme.beam.directory',
          principalType: 'agent',
          beamId: 'procurement@acme.beam.directory',
          workspaceBindingId: localBinding.binding.id,
          role: 'participant',
        },
      ],
    }),
  })

  const blockedThread = await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      kind: 'handoff',
      title: 'Invoice approval draft',
      summary: 'Blocked until the workflow approval is explicitly granted.',
      owner: harness.adminEmail,
      status: 'blocked',
      workflowType,
      participants: [
        {
          principalId: 'procurement@acme.beam.directory',
          principalType: 'agent',
          beamId: 'procurement@acme.beam.directory',
          workspaceBindingId: localBinding.binding.id,
          role: 'owner',
        },
        {
          principalId: 'finance@northwind.beam.directory',
          principalType: 'partner',
          beamId: 'finance@northwind.beam.directory',
          workspaceBindingId: partnerBinding.binding.id,
          role: 'participant',
        },
      ],
    }),
  })

  const linkedThread = await requestJson(`${harness.directoryUrl}/admin/workspaces/${workspaceSlug}/threads`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      kind: 'handoff',
      title: 'Invoice approval failure trace',
      summary: 'Linked failure trace for operator review.',
      owner: harness.adminEmail,
      workflowType,
      linkedIntentNonce: failedNonce,
      participants: [
        {
          principalId: 'procurement@acme.beam.directory',
          principalType: 'agent',
          beamId: 'procurement@acme.beam.directory',
          workspaceBindingId: localBinding.binding.id,
          role: 'owner',
        },
        {
          principalId: 'finance@northwind.beam.directory',
          principalType: 'partner',
          beamId: 'finance@northwind.beam.directory',
          workspaceBindingId: partnerBinding.binding.id,
          role: 'participant',
        },
      ],
    }),
  })

  return {
    harness,
    token,
    workspaceSlug,
    workflowType,
    failedNonce,
    ackedNonce,
    localBindingId: localBinding.binding.id,
    partnerBindingId: partnerBinding.binding.id,
    partnerChannelId: partnerChannel.channel.id,
    blockedThreadId: blockedThread.thread.id,
    linkedThreadId: linkedThread.thread.id,
  }
}
