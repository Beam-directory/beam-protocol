import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import {
  closeFleetClient,
  sendFleetIntent,
  startOpenClawFleetHarness,
} from './fleet-shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.2.0-fleet-smoke.md'))

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

    const conflictFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.beta,
      fleet.agents.alpha.beamId,
      'beta -> alpha while duplicate route exists',
      403,
    )

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
      revoked: {
        revokedHosts: postRevokeOverview.summary.revokedHosts,
        response: revokedFailure,
      },
    }

    const markdown = `# Beam 1.2.0 Fleet Smoke

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
4. Inject a duplicate Beam identity conflict and confirm delivery is blocked.
5. Revoke the conflicting host and confirm the revoked host stops accepting delivery immediately.

## Verification

- Approved hosts visible: \`${Object.keys(fleet.hosts).length}\`
- Ring messages delivered: \`${ring.length}\`
- Duplicate conflict count: \`${conflictOverview.summary.duplicateIdentityConflicts}\`
- Revoked hosts after remediation: \`${postRevokeOverview.summary.revokedHosts}\`
- Conflict response status: \`${conflictFailure.errorCode}\`
- Revoked response status: \`${revokedFailure.errorCode}\`

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
