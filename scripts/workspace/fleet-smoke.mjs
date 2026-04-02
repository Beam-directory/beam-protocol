import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import {
  closeFleetClient,
  sendFleetIntent,
  startOpenClawFleetHarness,
} from './fleet-shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.3.0-fleet-drill.md'))

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
  if (trace.intent.nonce !== response.payload.nonce) {
    throw new Error(`Trace nonce mismatch for ${sender.beamId} -> ${receiver.beamId}`)
  }

  return {
    nonce: response.payload.nonce,
    to: receiver.beamId,
    from: sender.beamId,
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

  try {
    const ring = []
    ring.push(await sendAndExpect(fleet, fleet.agents.alpha, fleet.agents.beta, 'fleet alpha -> beta', fleet.clients.beta))
    ring.push(await sendAndExpect(fleet, fleet.agents.beta, fleet.agents.gamma, 'fleet beta -> gamma', fleet.clients.gamma))
    ring.push(await sendAndExpect(fleet, fleet.agents.gamma, fleet.agents.alpha, 'fleet gamma -> alpha', fleet.clients.alpha))

    await fleet.createConflict()
    const conflictOverview = await fleet.fetchFleetOverview()
    if (conflictOverview.summary.duplicateIdentityConflicts !== 1) {
      throw new Error(`Expected one duplicate conflict after conflict injection, found ${conflictOverview.summary.duplicateIdentityConflicts}`)
    }

    const alphaConflict = await fleet.fetchHost(fleet.hosts.alpha.id)
    const gammaConflict = await fleet.fetchHost(fleet.hosts.gamma.id)
    const preferredAlphaRoute = alphaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId && route.runtimeSessionState === 'conflict')
    const duplicateAlphaRoute = gammaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId && route.runtimeSessionState === 'conflict')
    if (!preferredAlphaRoute || !duplicateAlphaRoute) {
      throw new Error('Expected duplicate alpha routes to surface on the alpha and gamma hosts.')
    }

    const conflictFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.beta,
      fleet.agents.alpha.beamId,
      'beta -> alpha while duplicate route exists',
      403,
    )

    await fleet.preferRoute(preferredAlphaRoute.id, 'Canonical alpha host route')
    await fleet.disableRoute(duplicateAlphaRoute.id, 'Disable duplicate alpha route on gamma')

    const resolvedOverview = await fleet.fetchFleetOverview()
    if (resolvedOverview.summary.duplicateIdentityConflicts !== 0) {
      throw new Error('Expected route-owner resolution to clear duplicate identity conflicts.')
    }

    const resolvedMessage = await sendAndExpect(
      fleet,
      fleet.agents.beta,
      fleet.agents.alpha,
      'beta -> alpha after conflict resolution',
      fleet.clients.alpha,
    )

    const rotated = await fleet.rotateHost('beta')
    if (rotated.host.credentialState !== 'rotation_pending') {
      throw new Error(`Expected beta host to enter rotation_pending, received ${rotated.host.credentialState}`)
    }
    await fleet.syncHost('beta', null, { stage: 'fleet-rotation-remediation' })

    await fleet.revokeHost('gamma', 'duplicate identity conflict drill')
    const postRevokeOverview = await fleet.fetchFleetOverview()
    if (postRevokeOverview.summary.revokedHosts !== 1 || postRevokeOverview.summary.duplicateIdentityConflicts !== 0) {
      throw new Error('Expected one revoked host and no remaining duplicate conflicts after the revoke action.')
    }

    await closeFleetClient(fleet.clients.gamma)
    const revokedFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma.beamId,
      'alpha -> gamma after revoke',
      403,
    )

    const recovered = await fleet.recoverHost('gamma')
    if (recovered.host.credentialState !== 'recovery_pending') {
      throw new Error(`Expected gamma host to enter recovery_pending, received ${recovered.host.credentialState}`)
    }
    await fleet.syncHost('gamma', null, { stage: 'fleet-recovery-remediation' })
    await fleet.reconnectHostClient('gamma')

    const recoveredMessage = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma,
      'alpha -> gamma after recovery',
      fleet.clients.gamma,
    )

    const result = {
      ok: true,
      date: formatDate(),
      workspace: fleet.workspaceSlug,
      hosts: Object.values(fleet.hosts).map((host) => ({
        id: host.id,
        label: host.label,
        hostname: host.hostname,
      })),
      ring,
      conflict: {
        duplicateIdentityConflicts: conflictOverview.summary.duplicateIdentityConflicts,
        response: conflictFailure,
      },
      resolved: {
        duplicateIdentityConflicts: resolvedOverview.summary.duplicateIdentityConflicts,
        message: resolvedMessage,
      },
      rotated: {
        hostId: rotated.host.id,
        credentialState: rotated.host.credentialState,
      },
      revoked: {
        revokedHosts: postRevokeOverview.summary.revokedHosts,
        response: revokedFailure,
      },
      recovered: {
        hostId: recovered.host.id,
        credentialState: recovered.host.credentialState,
        message: recoveredMessage,
      },
    }

    const markdown = `# Beam 1.3.0 Fleet Drill

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Bootstrap three approved OpenClaw hosts into one central Beam directory.
2. Connect one live Beam route per host over WebSocket.
3. Send a real ring of host-to-host messages so every host sends and receives at least once.
4. Inject a duplicate Beam identity conflict and confirm delivery is blocked until one explicit route owner is preferred and the duplicate route is disabled.
5. Rotate one host credential and confirm the host returns with the rotated secret.
6. Revoke a host, confirm delivery is blocked, then recover the host and confirm delivery resumes on the same Beam trace model.

## Verification

- Approved hosts visible: \`${Object.keys(fleet.hosts).length}\`
- Ring messages delivered: \`${ring.length}\`
- Duplicate conflict count: \`${conflictOverview.summary.duplicateIdentityConflicts}\`
- Duplicate conflicts after owner resolution: \`${resolvedOverview.summary.duplicateIdentityConflicts}\`
- Revoked hosts after remediation: \`${postRevokeOverview.summary.revokedHosts}\`
- Conflict response status: \`${conflictFailure.errorCode}\`
- Revoked response status: \`${revokedFailure.errorCode}\`
- Recovery credential state: \`${recovered.host.credentialState}\`

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
  console.error('[workspace:fleet-smoke] failed:', error)
  process.exitCode = 1
})
