import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  fileSha256,
  formatDate,
  formatDateTime,
  optionalFlag,
  resolveReleaseLabel,
  toJsonBlock,
  writeMarkdownReport,
} from '../production/shared.mjs'
import {
  closeFleetClient,
  sendFleetIntent,
  startOpenClawFleetHarness,
} from './fleet-shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-fleet-recovery-drill.md`))

function sqliteSnapshotMembers(basePath) {
  return [
    { key: 'db', path: basePath },
    { key: 'wal', path: `${basePath}-wal` },
    { key: 'shm', path: `${basePath}-shm` },
  ]
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function copySqliteSnapshot(sourceBasePath, targetBasePath) {
  for (const member of sqliteSnapshotMembers(sourceBasePath)) {
    const suffix = member.path.slice(sourceBasePath.length)
    const targetPath = `${targetBasePath}${suffix}`
    if (await pathExists(member.path)) {
      await copyFile(member.path, targetPath)
    } else {
      await rm(targetPath, { force: true })
    }
  }
}

async function checksumSqliteSnapshot(basePath) {
  const checksums = {}
  for (const member of sqliteSnapshotMembers(basePath)) {
    if (await pathExists(member.path)) {
      checksums[member.key] = await fileSha256(member.path)
    }
  }
  return checksums
}

async function corruptSqliteSnapshot(basePath, label) {
  for (const member of sqliteSnapshotMembers(basePath)) {
    if (await pathExists(member.path)) {
      await writeFile(member.path, `corrupted-${label}-${member.key}`, 'utf8')
    }
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
    const preRestoreMessage = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.beta,
      'alpha -> beta before fleet restore',
      fleet.clients.beta,
    )

    fleet.setHostConnectorVersion('beta', '1.6.1-test')
    await fleet.syncHost('beta', null, { stage: 'pre-restore-upgrade' })
    await fleet.updateRollout('beta', {
      ring: 'canary',
      desiredConnectorVersion: '1.6.1-test',
      notes: 'Recovery drill staged upgrade',
      rollbackConnectorVersion: '1.6.0-test',
      rollbackState: 'prepared',
      rollbackNotes: 'Rollback to last known good fleet connector',
    })

    const backupDir = path.join(fleet.harness.tempRoot, 'backups')
    await mkdir(backupDir, { recursive: true })
    const directoryBackupPath = path.join(backupDir, 'beam-directory.sqlite')

    await copySqliteSnapshot(fleet.harness.directoryDbPath, directoryBackupPath)
    const backupChecksums = await checksumSqliteSnapshot(directoryBackupPath)

    await fleet.harness.stopServices()
    await corruptSqliteSnapshot(fleet.harness.directoryDbPath, 'fleet-directory')
    await copySqliteSnapshot(directoryBackupPath, fleet.harness.directoryDbPath)
    const restoredChecksums = await checksumSqliteSnapshot(fleet.harness.directoryDbPath)

    await fleet.harness.startServices()
    await Promise.all([
      fleet.reconnectHostClient('alpha'),
      fleet.reconnectHostClient('beta'),
      fleet.reconnectHostClient('gamma'),
    ])
    await fleet.syncHost('alpha', null, { stage: 'post-restore-republish' })
    await fleet.syncHost('beta', null, { stage: 'post-restore-republish' })
    await fleet.syncHost('gamma', null, { stage: 'post-restore-republish' })

    const postRestoreOverview = await fleet.fetchFleetOverview()
    if (postRestoreOverview.summary.totalHosts !== 3 || postRestoreOverview.summary.activeHosts !== 3) {
      throw new Error(`Expected 3 active hosts after restore, received ${JSON.stringify(postRestoreOverview.summary)}`)
    }

    const postRestoreMessage = await sendAndExpect(
      fleet,
      fleet.agents.beta,
      fleet.agents.gamma,
      'beta -> gamma after fleet restore',
      fleet.clients.gamma,
    )

    const rollbackStarted = await fleet.rollbackHost('beta', {
      notes: 'Rollback after restore verification',
    })
    if (rollbackStarted.host.rollout.rollbackState !== 'rollback_pending') {
      throw new Error(`Expected beta rollback state rollback_pending, received ${rollbackStarted.host.rollout.rollbackState}`)
    }
    fleet.setHostConnectorVersion('beta', '1.6.0-test')
    await fleet.syncHost('beta', null, { stage: 'post-restore-rollback' })
    const rollbackCompleted = await fleet.fetchHost(fleet.hosts.beta.id)
    if (rollbackCompleted.host.rollout.rollbackState !== 'completed') {
      throw new Error(`Expected beta rollback state completed, received ${rollbackCompleted.host.rollout.rollbackState}`)
    }

    await fleet.revokeHost('gamma', 'fleet recovery revoke drill')
    await closeFleetClient(fleet.clients.gamma)
    const revokedFailure = await sendAndExpectFailure(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma.beamId,
      'alpha -> gamma while revoked after restore',
      403,
    )

    const recovered = await fleet.recoverHost('gamma')
    if (recovered.host.credentialState !== 'recovery_pending') {
      throw new Error(`Expected gamma credentialState recovery_pending, received ${recovered.host.credentialState}`)
    }
    await fleet.syncHost('gamma', null, { stage: 'post-restore-recovery' })
    await fleet.reconnectHostClient('gamma')
    const recoveredMessage = await sendAndExpect(
      fleet,
      fleet.agents.alpha,
      fleet.agents.gamma,
      'alpha -> gamma after host recovery',
      fleet.clients.gamma,
    )

    const snapshotRestored = JSON.stringify(backupChecksums) === JSON.stringify(restoredChecksums)
    if (!snapshotRestored) {
      throw new Error('Restored directory checksum did not match the backup snapshot.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      workspace: fleet.workspaceSlug,
      backupChecksums,
      restoredChecksums,
      preRestoreMessage,
      postRestore: {
        hosts: postRestoreOverview.summary.totalHosts,
        activeHosts: postRestoreOverview.summary.activeHosts,
        revokedHosts: postRestoreOverview.summary.revokedHosts,
      },
      postRestoreMessage,
      rollback: {
        hostId: rollbackCompleted.host.id,
        connectorVersion: rollbackCompleted.host.connectorVersion,
        desiredConnectorVersion: rollbackCompleted.host.rollout.desiredConnectorVersion,
        rollbackState: rollbackCompleted.host.rollout.rollbackState,
      },
      revokedFailure,
      recovered: {
        hostId: recovered.host.id,
        credentialState: recovered.host.credentialState,
        message: recoveredMessage,
      },
      report: outputPath,
    }

    const markdown = `# Beam ${releaseLabel} Fleet Recovery Drill

## Context

- Date: ${formatDate()}
- Workspace: \`${fleet.workspaceSlug}\`
- Output: \`${outputPath}\`

## Recovery Steps

1. Send a real cross-host message before taking the fleet snapshot.
2. Snapshot the central Beam directory database.
3. Stop services, corrupt the live database, and restore the snapshot.
4. Restart Beam, reconnect all host routes, and verify cross-host delivery.
5. Start and complete a connector rollback on one host after restore.
6. Revoke and recover another host, then prove delivery resumes.

## Checksums

- Backup snapshot:

${toJsonBlock(backupChecksums)}

- Restored snapshot:

${toJsonBlock(restoredChecksums)}

## Evidence

- Pre-restore message: \`${preRestoreMessage.from}\` -> \`${preRestoreMessage.to}\`
- Post-restore hosts active: \`${postRestoreOverview.summary.activeHosts}\`
- Post-restore message nonce: \`${postRestoreMessage.nonce}\`
- Rollback completed on host \`${rollbackCompleted.host.id}\` with connector \`${rollbackCompleted.host.connectorVersion}\`
- Recovery message nonce: \`${recoveredMessage.nonce}\`

## Result

${toJsonBlock(result)}
`

    await writeMarkdownReport(outputPath, markdown)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await fleet.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
