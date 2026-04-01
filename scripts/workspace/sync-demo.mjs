import { generateKeyPairSync } from 'node:crypto'
import { optionalFlag, requestJson } from '../production/shared.mjs'

const directoryUrl = optionalFlag('--directory-url', 'http://localhost:43100')
const dashboardUrl = optionalFlag('--dashboard-url', 'http://localhost:43173')
const adminEmail = optionalFlag('--email', 'ops@beam.local')

const sourceWorkspace = {
  name: 'Acme Sync Demo',
  slug: 'acme-sync-demo',
  description: 'Operator-friendly local workspace used to prove cross-workspace Beam sync.',
}

const targetWorkspace = {
  name: 'Northwind Sync Demo',
  slug: 'northwind-sync-demo',
  description: 'Receives the routed handoff so the target workspace shows the inbound thread automatically.',
}

const sourceIdentity = {
  beamId: 'procurement@acme.beam.directory',
  displayName: 'Acme Procurement Desk',
  bindingType: 'agent',
  runtimeType: 'demo:procurement',
  policyProfile: 'quote-default',
  canInitiateExternal: true,
  notes: 'Local sender for the cross-workspace sync demo.',
}

const targetIdentity = {
  beamId: 'echo@beam.directory',
  displayName: 'Beam Echo',
  bindingType: 'service',
  runtimeType: 'builtin:echo',
  policyProfile: 'echo-default',
  canInitiateExternal: true,
  notes: 'Built-in echo receiver used to prove local routed workspace sync.',
}

const workflowType = 'workspace.sync.demo'
const intentType = 'conversation.message'
const message = 'Hello from Acme. Please confirm the local cross-workspace sync demo.'

function createIdentityPublicKey() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

async function requestJsonAllow(url, init, allowedStatuses = []) {
  const response = await fetch(url, init)
  const text = await response.text()
  const payload = text.length > 0 ? JSON.parse(text) : null
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return { status: response.status, payload }
}

async function createAdminToken() {
  const challenge = await requestJson(`${directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: dashboardUrl,
    },
    body: JSON.stringify({ email: adminEmail }),
  })

  const verify = await requestJson(`${directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })

  return {
    token: verify.token,
    magicUrl: challenge.url,
  }
}

function createAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function ensureAgent(beamId, displayName) {
  const existing = await requestJsonAllow(`${directoryUrl}/agents/${encodeURIComponent(beamId)}`, undefined, [404])
  if (existing.status === 200 && existing.payload) {
    return existing.payload
  }

  return requestJson(`${directoryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      beamId,
      displayName,
      capabilities: [intentType],
      publicKey: createIdentityPublicKey(),
      description: 'Local workspace sync demo identity',
      visibility: 'unlisted',
    }),
  })
}

async function ensureWorkspace(adminHeaders, definition) {
  const existing = await requestJsonAllow(`${directoryUrl}/admin/workspaces/${definition.slug}`, {
    headers: { Authorization: adminHeaders.Authorization },
  }, [404])
  if (existing.status === 200 && existing.payload?.workspace) {
    return existing.payload.workspace
  }

  const created = await requestJson(`${directoryUrl}/admin/workspaces`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      ...definition,
      status: 'active',
      externalHandoffsEnabled: true,
    }),
  })

  return created.workspace
}

async function ensureBinding(adminHeaders, workspaceSlug, definition) {
  const list = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    headers: { Authorization: adminHeaders.Authorization },
  })
  const existing = list.bindings.find((entry) => entry.beamId === definition.beamId)
  if (existing) {
    const updated = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities/${existing.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: adminEmail,
        runtimeType: definition.runtimeType,
        policyProfile: definition.policyProfile,
        canInitiateExternal: definition.canInitiateExternal,
        status: 'active',
        notes: definition.notes,
      }),
    })
    return updated.binding
  }

  const created = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/identities`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      beamId: definition.beamId,
      bindingType: definition.bindingType,
      owner: adminEmail,
      runtimeType: definition.runtimeType,
      policyProfile: definition.policyProfile,
      canInitiateExternal: definition.canInitiateExternal,
      status: 'active',
      notes: definition.notes,
    }),
  })
  return created.binding
}

async function ensurePartnerChannel(adminHeaders, workspaceSlug, partnerBeamId) {
  const list = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels`, {
    headers: { Authorization: adminHeaders.Authorization },
  })
  const existing = list.channels.find((entry) => entry.partnerBeamId === partnerBeamId)
  if (existing) {
    const updated = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels/${existing.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        label: 'Beam Echo Route',
        owner: adminEmail,
        status: 'active',
        notes: 'Local route into the target workspace for the one-command sync demo.',
      }),
    })
    return updated.channel
  }

  const created = await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/partner-channels`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      partnerBeamId,
      label: 'Beam Echo Route',
      owner: adminEmail,
      status: 'active',
      notes: 'Local route into the target workspace for the one-command sync demo.',
    }),
  })
  return created.channel
}

async function ensurePolicy(adminHeaders, workspaceSlug, partnerBeamId) {
  await requestJson(`${directoryUrl}/admin/workspaces/${workspaceSlug}/policy`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({
      defaults: {
        externalInitiation: 'binding',
        allowedPartners: [partnerBeamId],
      },
      workflowRules: [
        {
          workflowType,
          requireApproval: true,
          allowedPartners: [partnerBeamId],
          approvers: [adminEmail],
        },
      ],
      metadata: {
        notes: 'Local sync demo policy that allows the routed handoff after operator approval.',
      },
    }),
  })
}

async function createThread(adminHeaders, sourceBinding, targetBinding) {
  const created = await requestJson(`${directoryUrl}/admin/workspaces/${sourceWorkspace.slug}/threads`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      kind: 'handoff',
      title: 'Friendly workspace sync demo',
      summary: 'This should appear automatically in the Northwind workspace.',
      owner: adminEmail,
      status: 'blocked',
      workflowType,
      draftIntentType: intentType,
      draftPayload: { message },
      participants: [
        {
          principalId: sourceBinding.beamId,
          principalType: 'agent',
          beamId: sourceBinding.beamId,
          workspaceBindingId: sourceBinding.id,
          role: 'owner',
        },
        {
          principalId: targetBinding.beamId,
          principalType: 'partner',
          beamId: targetBinding.beamId,
          role: 'participant',
        },
      ],
    }),
  })

  return created.thread
}

async function main() {
  const { token, magicUrl } = await createAdminToken()
  const adminHeaders = createAdminHeaders(token)

  await ensureAgent(sourceIdentity.beamId, sourceIdentity.displayName)
  await ensureAgent(targetIdentity.beamId, targetIdentity.displayName)

  await ensureWorkspace(adminHeaders, sourceWorkspace)
  await ensureWorkspace(adminHeaders, targetWorkspace)

  const sourceBinding = await ensureBinding(adminHeaders, sourceWorkspace.slug, sourceIdentity)
  const targetBinding = await ensureBinding(adminHeaders, targetWorkspace.slug, targetIdentity)
  await ensurePartnerChannel(adminHeaders, sourceWorkspace.slug, targetBinding.beamId)
  await ensurePolicy(adminHeaders, sourceWorkspace.slug, targetBinding.beamId)

  const thread = await createThread(adminHeaders, sourceBinding, targetBinding)
  const dispatch = await requestJson(`${directoryUrl}/admin/workspaces/${sourceWorkspace.slug}/threads/${thread.id}/dispatch`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      intentType,
      payload: { message },
    }),
  })

  const targetThreadId = dispatch.workspaceSync?.threadId ?? null
  const traceUrl = `${dashboardUrl}${dispatch.dispatch.traceHref}`
  const sourceUrl = `${dashboardUrl}/workspaces?workspace=${encodeURIComponent(sourceWorkspace.slug)}&thread=${thread.id}`
  const targetUrl = targetThreadId
    ? `${dashboardUrl}/workspaces?workspace=${encodeURIComponent(targetWorkspace.slug)}&thread=${targetThreadId}`
    : `${dashboardUrl}/workspaces?workspace=${encodeURIComponent(targetWorkspace.slug)}`

  console.log('')
  console.log('Beam workspace sync demo is ready.')
  console.log('')
  console.log(`Login link:   ${magicUrl}`)
  console.log(`Source page:  ${sourceUrl}`)
  console.log(`Target page:  ${targetUrl}`)
  console.log(`Trace page:   ${traceUrl}`)
  console.log(`Nonce:        ${dispatch.dispatch.nonce}`)
  console.log('')
  console.log(`Source thread ${thread.id} in ${sourceWorkspace.slug} dispatched ${intentType}.`)
  if (targetThreadId) {
    console.log(`Target thread ${targetThreadId} was created automatically in ${targetWorkspace.slug}.`)
  } else {
    console.log(`The target workspace route did not return a thread id. Open the target workspace to inspect it.`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
