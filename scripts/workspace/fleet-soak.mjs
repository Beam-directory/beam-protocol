import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startWebhookCapture } from './fleet-evidence-shared.mjs'
import {
  sendFleetIntent,
  startOpenClawFleetHarness,
} from './fleet-shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-fleet-soak.md`))

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
  const responsePromise = sendFleetIntent(fleet.harness.directoryUrl, sender, receiver.beamId, {
    message,
  })
  const inbound = await expectInbound(receiverClient, sender.beamId, message)
  const response = await responsePromise
  if (!response.ok) {
    throw new Error(`Expected a successful intent send from ${sender.beamId} to ${receiver.beamId}: ${JSON.stringify(response.payload)}`)
  }
  const trace = await fleet.fetchTrace(response.payload.nonce)
  if (trace.intent.status !== 'acked') {
    throw new Error(`Expected the trace for ${sender.beamId} -> ${receiver.beamId} to reach acked, received ${trace.intent.status}`)
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

async function syncAllHosts(fleet, stage) {
  await fleet.syncHost('alpha', null, { stage })
  await fleet.syncHost('beta', null, { stage })
  await fleet.syncHost('gamma', null, { stage })
}

async function main() {
  const fleet = await startOpenClawFleetHarness()
  const alertWebhook = await startWebhookCapture()

  try {
    const alertTarget = await fleet.createFleetAlertTarget({
      label: 'Soak webhook',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
      notes: 'Accelerated multi-day fleet soak webhook',
      headers: {
        'x-beam-soak': '1.6.0',
      },
    })

    const now = new Date()
    await fleet.updateFleetDigestSchedule({
      enabled: true,
      deliveryEmail: 'ops@example.com',
      escalationEmail: 'critical@example.com',
      runHourUtc: now.getUTCHours(),
      runMinuteUtc: now.getUTCMinutes(),
      escalateOnCritical: true,
    }, 'operator')

    const days = []

    await syncAllHosts(fleet, 'soak-day-1-baseline')
    const day1Message = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.beta,
      'soak day 1 alpha -> beta',
      fleet.clients.beta,
    )
    days.push({
      day: 1,
      label: 'baseline ring',
      health: (await fleet.fetchFleetOverview()).summary,
      message: day1Message,
      alerts: 0,
    })

    await fleet.updateRollout('alpha', {
      ring: 'canary',
      desiredConnectorVersion: '1.6.0-soak-canary',
      notes: 'Accelerated soak canary lane',
    })
    await fleet.setHostConnectorVersion('alpha', '1.6.0-soak-canary')
    await syncAllHosts(fleet, 'soak-day-2-rollout')
    const day2Message = await sendAndExpect(
      fleet,
      fleet.agents.beta,
      fleet.agents.gamma,
      'soak day 2 beta -> gamma',
      fleet.clients.gamma,
    )
    const day2Overview = await fleet.fetchFleetOverview()
    days.push({
      day: 2,
      label: 'canary rollout',
      rollout: day2Overview.rollout.summary,
      message: day2Message,
      alerts: 0,
    })

    await fleet.markHostStale('beta', 18)
    const day3Digest = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    const day3Events = await alertWebhook.waitForCount(1)
    await fleet.syncHost('beta', null, { stage: 'soak-day-3-remediation' })
    days.push({
      day: 3,
      label: 'stale host alert',
      staleHosts: day3Digest.digest.summary.staleHosts,
      alertItems: day3Events.at(-1).body.matchingItems.length,
      deliveryState: day3Digest.run.deliveryState,
    })

    const rotated = await fleet.rotateHost('beta')
    const day4Digest = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    const day4Events = await alertWebhook.waitForCount(2)
    await fleet.syncHost('beta', null, { stage: 'soak-day-4-rotation-remediation' })
    days.push({
      day: 4,
      label: 'credential rotation',
      credentialState: rotated.host.credentialState,
      pendingCredentialActions: day4Digest.digest.summary.pendingCredentialActions,
      alertItems: day4Events.at(-1).body.matchingItems.length,
    })

    await fleet.createConflict()
    const conflictFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.beta,
      fleet.agents.alpha.beamId,
      'soak day 5 duplicate conflict',
      403,
    )
    const day5Digest = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    const day5Events = await alertWebhook.waitForCount(3)
    const alphaConflict = await fleet.fetchHost(fleet.hosts.alpha.id)
    const gammaConflict = await fleet.fetchHost(fleet.hosts.gamma.id)
    const preferredAlphaRoute = alphaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId && route.runtimeSessionState === 'conflict')
    const duplicateAlphaRoute = gammaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId && route.runtimeSessionState === 'conflict')
    if (!preferredAlphaRoute || !duplicateAlphaRoute) {
      throw new Error('Expected duplicate alpha routes during accelerated soak conflict injection.')
    }
    await fleet.preferRoute(preferredAlphaRoute.id, 'Soak preferred owner')
    await fleet.disableRoute(duplicateAlphaRoute.id, 'Soak disabled duplicate route')
    await fleet.syncHost('gamma', null, { stage: 'soak-day-5-conflict-remediation' })
    days.push({
      day: 5,
      label: 'duplicate identity conflict',
      duplicateIdentityConflicts: day5Digest.digest.summary.duplicateIdentityConflicts,
      blockedDelivery: conflictFailure.errorCode ?? conflictFailure.error,
      alertItems: day5Events.at(-1).body.matchingItems.length,
    })

    const drained = await fleet.drainHost('alpha', {
      owner: 'ops@example.com',
      reason: 'Accelerated soak drain',
    })
    const drainFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.gamma,
      fleet.agents.alpha.beamId,
      'soak day 6 gamma -> alpha while draining',
      403,
    )
    const day6Digest = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    const day6Events = await alertWebhook.waitForCount(4)
    await fleet.resumeHost('alpha')
    const day6RecoveredMessage = await sendAndExpect(
      fleet,
      fleet.agents.gamma,
      fleet.agents.alpha,
      'soak day 6 gamma -> alpha after resume',
      fleet.clients.alpha,
    )
    days.push({
      day: 6,
      label: 'maintenance drain and resume',
      maintenanceState: drained.host.maintenance.state,
      blockedDelivery: drainFailure.errorCode ?? drainFailure.error,
      resumedMessage: day6RecoveredMessage.nonce,
      alertItems: day6Events.at(-1).body.matchingItems.length,
      criticalItems: day6Digest.digest.summary.criticalItems,
    })

    await fleet.revokeHost('gamma', 'Accelerated soak revoke')
    const revokeFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma.beamId,
      'soak day 7 alpha -> gamma while revoked',
      403,
    )
    const day7Digest = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    const day7Events = await alertWebhook.waitForCount(5)
    await fleet.recoverHost('gamma')
    await fleet.syncHost('gamma', null, { stage: 'soak-day-7-recovery' })
    await fleet.reconnectHostClient('gamma')
    const day7RecoveredMessage = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma,
      'soak day 7 alpha -> gamma after recovery',
      fleet.clients.gamma,
    )
    days.push({
      day: 7,
      label: 'revoke and recovery',
      blockedDelivery: revokeFailure.errorCode ?? revokeFailure.error,
      recoveredMessage: day7RecoveredMessage.nonce,
      revokedHosts: day7Digest.digest.summary.revokedHosts ?? 1,
      alertItems: day7Events.at(-1).body.matchingItems.length,
    })

    const finalOverview = await fleet.fetchFleetOverview()
    const alerts = await fleet.fetchFleetAlerts()

    const result = {
      ok: true,
      date: formatDate(),
      accelerated: true,
      workspace: fleet.workspaceSlug,
      hosts: Object.values(fleet.hosts).map((host) => ({
        id: host.id,
        label: host.label,
        hostname: host.hostname,
      })),
      alertTargetId: alertTarget.target.id,
      dayCount: days.length,
      webhookDeliveries: alerts.deliveries.filter((delivery) => delivery.status === 'delivered').length,
      finalSummary: finalOverview.summary,
      days,
    }

    const markdown = `# Beam ${releaseLabel} Fleet Soak

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness
- mode: accelerated seven-day soak on one real harness run

## Result

\`PASS\`

## Scenario

1. Keep one central Beam fleet with three approved OpenClaw hosts alive through seven synthetic operating days.
2. Re-publish inventory and heartbeat on every host while continuing real cross-host delivery.
3. Exercise stale-host alerting, credential rotation, duplicate conflict handling, drain/resume, and revoke/recover inside the same run.
4. Deliver external fleet alerts to a real webhook target so the soak evidence includes persisted off-platform escalation.

## Verification

- Synthetic days: \`${days.length}\`
- Delivered webhook alerts: \`${result.webhookDeliveries}\`
- Final active hosts: \`${finalOverview.summary.activeHosts}\`
- Final live routes: \`${finalOverview.summary.liveRoutes}\`
- Final duplicate conflicts: \`${finalOverview.summary.duplicateIdentityConflicts}\`
- Final revoked hosts: \`${finalOverview.summary.revokedHosts}\`

## Notes

- This is accelerated soak evidence, not a literal seven-calendar-day wall-clock run.
- The evidence is still based on one real three-host harness with live heartbeats, real route changes, real delivery attempts, and persisted fleet alert deliveries.

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
  console.error('[workspace:fleet-soak] failed:', error)
  process.exitCode = 1
})
