import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startWebhookCapture } from './fleet-evidence-shared.mjs'
import {
  sendFleetIntent,
  startOpenClawFleetHarness,
} from './fleet-shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-incident-drill.md`))

function assertStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`Expected ${label} to return ${status}, received ${response.status}: ${JSON.stringify(response.payload)}`)
  }
}

async function expectInbound(ws, expectedFrom, expectedMessage) {
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for inbound payload from ${expectedFrom}`)), 15_000)
    ws.once('message', (chunk) => {
      clearTimeout(timer)
      resolve(JSON.parse(Buffer.from(chunk).toString('utf8')))
    })
  })

  if (payload.type !== 'intent') {
    throw new Error(`Expected an intent frame, received ${JSON.stringify(payload)}`)
  }
  const frame = payload.frame
  if (!frame || typeof frame !== 'object') {
    throw new Error(`Expected an intent frame payload, received ${JSON.stringify(payload)}`)
  }
  if (frame.from !== expectedFrom) {
    throw new Error(`Expected sender ${expectedFrom}, received ${frame.from}`)
  }
  if (frame.payload?.message !== expectedMessage) {
    throw new Error(`Expected payload message "${expectedMessage}", received ${JSON.stringify(frame.payload)}`)
  }

  ws.send(JSON.stringify({
    type: 'result',
    frame: {
      v: '1',
      success: true,
      nonce: frame.nonce,
      timestamp: new Date().toISOString(),
      payload: {
        ok: true,
        acknowledgedBy: frame.to,
        echoedMessage: frame.payload?.message ?? null,
      },
    },
  }))

  return frame
}

async function sendAndExpect(fleet, sender, receiver, message, receiverClient) {
  const responsePromise = sendFleetIntent(fleet.harness.directoryUrl, sender, receiver.beamId, { message })
  const inbound = await expectInbound(receiverClient, sender.beamId, message)
  const response = await responsePromise
  if (!response.ok) {
    throw new Error(`Expected a successful send from ${sender.beamId} to ${receiver.beamId}: ${JSON.stringify(response.payload)}`)
  }
  const trace = await fleet.fetchTrace(response.payload.nonce)
  if (trace.intent.status !== 'acked') {
    throw new Error(`Expected trace ${response.payload.nonce} to reach acked, received ${trace.intent.status}`)
  }
  return {
    nonce: response.payload.nonce,
    from: sender.beamId,
    to: receiver.beamId,
    traceStatus: trace.intent.status,
    deliveredMessage: inbound.payload.message,
  }
}

async function sendAndExpectFailure(fleet, sender, receiverBeamId, message, expectedStatus) {
  const response = await sendFleetIntent(fleet.harness.directoryUrl, sender, receiverBeamId, { message })
  if (response.ok || response.status !== expectedStatus) {
    throw new Error(`Expected send to ${receiverBeamId} to fail with ${expectedStatus}, received ${response.status}: ${JSON.stringify(response.payload)}`)
  }
  return response.payload
}

async function main() {
  const fleet = await startOpenClawFleetHarness()
  const alertWebhook = await startWebhookCapture()

  try {
    const viewerCreateAlertDenied = await fleet.createFleetAlertTarget({
      label: 'viewer denied',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
    }, 'viewer', true)
    assertStatus(viewerCreateAlertDenied, 403, 'viewer alert-target creation')

    const operatorCreateAlertDenied = await fleet.createFleetAlertTarget({
      label: 'operator denied',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
    }, 'operator', true)
    assertStatus(operatorCreateAlertDenied, 403, 'operator alert-target creation')

    const alertTarget = await fleet.createFleetAlertTarget({
      label: 'Incident webhook',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'critical',
      notes: 'Webhook used by the 1.6.0 incident drill',
      headers: {
        'x-beam-incident': '1.6.0',
      },
    })

    const now = new Date()
    const viewerDigestDenied = await fleet.requestRole('/admin/openclaw/fleet/digest/schedule', {
      role: 'viewer',
      method: 'PATCH',
      body: {
        enabled: true,
        runHourUtc: now.getUTCHours(),
        runMinuteUtc: now.getUTCMinutes(),
      },
      allowError: true,
    })
    assertStatus(viewerDigestDenied, 403, 'viewer digest schedule update')

    const digestSchedule = await fleet.updateFleetDigestSchedule({
      enabled: true,
      deliveryEmail: 'ops@example.com',
      escalationEmail: 'critical@example.com',
      runHourUtc: now.getUTCHours(),
      runMinuteUtc: now.getUTCMinutes(),
      escalateOnCritical: true,
    }, 'operator')
    if (!digestSchedule.schedule.enabled) {
      throw new Error('Expected operator to enable the digest schedule.')
    }

    const testAlert = await fleet.testFleetAlertTarget(alertTarget.target.id, 'operator')
    if (!testAlert.ok || testAlert.status !== 'delivered') {
      throw new Error(`Expected operator alert-target test delivery to succeed, received ${JSON.stringify(testAlert)}`)
    }
    const [testWebhookEvent] = await alertWebhook.waitForCount(1)
    if (testWebhookEvent.body?.test !== true) {
      throw new Error('Expected the first webhook event to be the explicit test delivery.')
    }

    const operatorRotateDenied = await fleet.rotateHost('beta', 'operator', true)
    assertStatus(operatorRotateDenied, 403, 'operator host rotation')

    const rotated = await fleet.rotateHost('beta')
    if (rotated.host.credentialState !== 'rotation_pending') {
      throw new Error(`Expected beta host to enter rotation_pending, received ${rotated.host.credentialState}`)
    }
    await fleet.syncHost('beta', null, { stage: 'incident-drill-rotation-remediation' })

    await fleet.markHostStale('beta', 30, { ageRoutes: true })
    await fleet.revokeHost('gamma', 'Incident drill host isolation')
    const failedDelivery = await sendAndExpectFailure(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma.beamId,
      'incident drill alpha -> gamma while host revoked',
      403,
    )

    const digestRun = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    if (!digestRun.run || digestRun.run.deliveryState === 'skipped') {
      throw new Error('Expected the incident drill digest run to persist delivery evidence.')
    }

    const alertEvents = await alertWebhook.waitForCount(2)
    const liveWebhookEvent = alertEvents.at(-1)
    if (!liveWebhookEvent?.body || liveWebhookEvent.body.test === true) {
      throw new Error('Expected the live incident webhook delivery after the test event.')
    }
    if ((liveWebhookEvent.body.matchingItems?.length ?? 0) < 1) {
      throw new Error('Expected the live incident alert payload to include at least one matching critical item.')
    }

    const alerts = await fleet.fetchFleetAlerts('viewer')
    if (alerts.deliveries.length < 2) {
      throw new Error('Expected the incident drill to leave persisted alert delivery history.')
    }

    const recovered = await fleet.recoverHost('gamma')
    if (recovered.host.credentialState !== 'recovery_pending') {
      throw new Error(`Expected gamma host to enter recovery_pending, received ${recovered.host.credentialState}`)
    }
    await fleet.syncHost('gamma', null, { stage: 'incident-drill-recovery-remediation' })
    await fleet.reconnectHostClient('gamma')
    await fleet.syncHost('beta', null, { stage: 'incident-drill-stale-remediation' })

    const recoveredMessage = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma,
      'incident drill alpha -> gamma after recovery',
      fleet.clients.gamma,
    )

    const finalOverview = await fleet.fetchFleetOverview()
    const result = {
      ok: true,
      date: formatDate(),
      workspace: fleet.workspaceSlug,
      rbac: {
        viewerAlertCreateStatus: viewerCreateAlertDenied.status,
        operatorAlertCreateStatus: operatorCreateAlertDenied.status,
        viewerDigestScheduleStatus: viewerDigestDenied.status,
        operatorRotateStatus: operatorRotateDenied.status,
      },
      alerting: {
        targetId: alertTarget.target.id,
        testStatus: testAlert.status,
        webhookEvents: alertEvents.length,
        liveMatchingItems: liveWebhookEvent.body.matchingItems.length,
        persistedDeliveries: alerts.deliveries.length,
      },
      incident: {
        staleHosts: digestRun.digest.summary.staleHosts,
        pendingCredentialActions: digestRun.digest.summary.pendingCredentialActions,
        criticalItems: digestRun.digest.summary.criticalItems,
        failedDelivery,
      },
      recovered: {
        hostId: recovered.host.id,
        credentialState: recovered.host.credentialState,
        message: recoveredMessage,
      },
      finalSummary: finalOverview.summary,
    }

    const markdown = `# Beam ${releaseLabel} Incident Drill

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Prove real RBAC boundaries for viewer, operator, and admin on fleet alerting and destructive host actions.
2. Create one webhook alert target as admin and test it as operator.
3. Rotate one host credential through the admin path, then restore it with a fresh sync.
4. Force one stale host plus one revoked host so a real delivery fails and the digest/escalation path becomes active.
5. Deliver the incident alert externally through the configured webhook target.
6. Recover the revoked host and confirm live delivery returns on the same Beam trace model.

## Verification

- Viewer alert-create guard: \`${viewerCreateAlertDenied.status}\`
- Operator alert-create guard: \`${operatorCreateAlertDenied.status}\`
- Viewer digest-schedule guard: \`${viewerDigestDenied.status}\`
- Operator rotate guard: \`${operatorRotateDenied.status}\`
- Webhook events captured: \`${alertEvents.length}\`
- Critical items in incident digest: \`${digestRun.digest.summary.criticalItems}\`
- Final active hosts: \`${finalOverview.summary.activeHosts}\`
- Final revoked hosts: \`${finalOverview.summary.revokedHosts}\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(outputPath, markdown)
    console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
  } finally {
    await alertWebhook.close()
    await fleet.cleanup()
  }
}

main().catch((error) => {
  console.error('[workspace:incident-drill] failed:', error)
  process.exitCode = 1
})
