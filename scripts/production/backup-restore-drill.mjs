import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createAdminHeaders,
  fileSha256,
  formatDate,
  formatDateTime,
  optionalFlag,
  requestJson,
  seedAckedIntent,
  seedProofAgents,
  startProductionHarness,
  toJsonBlock,
  writeMarkdownReport,
} from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-recovery-drill.md'))

async function createHostedBetaRequest(directoryUrl) {
  return requestJson(`${directoryUrl}/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'recovery@example.com',
      source: 'hosted-beta-page',
      company: 'Recovery Fixture Co',
      agentCount: 4,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Validate backup and restore of one production-like partner thread.',
    }),
  })
}

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

function normalizeRelease(payload) {
  const release = payload && typeof payload === 'object' && payload.release && typeof payload.release === 'object'
    ? payload.release
    : payload

  if (!release || typeof release !== 'object') {
    return null
  }

  return {
    version: typeof release.version === 'string' ? release.version : null,
    gitSha: typeof release.gitSha === 'string' ? release.gitSha : null,
    deployedAt: typeof release.deployedAt === 'string' ? release.deployedAt : null,
  }
}

async function fetchReleaseParity(directoryUrl) {
  const [health, stats, release] = await Promise.all([
    requestJson(`${directoryUrl}/health`),
    requestJson(`${directoryUrl}/stats`),
    requestJson(`${directoryUrl}/release`),
  ])

  const normalizedHealth = normalizeRelease(health)
  const normalizedStats = normalizeRelease(stats)
  const normalizedRelease = normalizeRelease(release)

  return {
    health: normalizedHealth,
    stats: normalizedStats,
    release: normalizedRelease,
    consistent: JSON.stringify(normalizedHealth) === JSON.stringify(normalizedStats)
      && JSON.stringify(normalizedHealth) === JSON.stringify(normalizedRelease),
  }
}

async function main() {
  const harness = await startProductionHarness({
    withMessageBus: true,
    seed: {
      directory(db, directoryDbApi) {
        seedProofAgents(db, directoryDbApi)
        seedAckedIntent(db, directoryDbApi, 'recovery-proof-acked-1', '2026-03-31T10:15:30.000Z')
      },
      messageBus(db, messageBusDbApi) {
        const ackedId = messageBusDbApi.insertMessage(db, {
          nonce: 'bus-acked-1',
          sender: 'procurement@acme.beam.directory',
          recipient: 'finance@northwind.beam.directory',
          intent: 'conversation.message',
          payload: { message: 'approved' },
        })
        messageBusDbApi.markDispatched(db, ackedId)
        messageBusDbApi.markDelivered(db, ackedId)
        messageBusDbApi.markAcked(db, ackedId, { success: true })

        const deadLetterId = messageBusDbApi.insertMessage(db, {
          nonce: 'bus-dead-letter-1',
          sender: 'procurement@acme.beam.directory',
          recipient: 'finance@northwind.beam.directory',
          intent: 'conversation.message',
          payload: { message: 'timed out' },
        })
        messageBusDbApi.markDispatched(db, deadLetterId)
        messageBusDbApi.markDeadLetter(db, deadLetterId, 'Timed out waiting for receiver.')
      },
    },
  })

  try {
    const token = await harness.createAdminToken()
    const created = await createHostedBetaRequest(harness.directoryUrl)
    await requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: createAdminHeaders(token),
      body: JSON.stringify({
        status: 'scheduled',
        owner: harness.adminEmail,
        nextAction: 'Validate restore before production sign-off.',
        nextMeetingAt: '2026-04-04T09:00:00.000Z',
        proofIntentNonce: 'recovery-proof-acked-1',
      }),
    })

    const preRestore = {
      parity: await fetchReleaseParity(harness.directoryUrl),
      requests: await requestJson(`${harness.directoryUrl}/admin/beta-requests`, {
        headers: createAdminHeaders(token),
      }),
      requestDetail: await requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      partnerHealth: await requestJson(`${harness.directoryUrl}/admin/partner-health`, {
        headers: createAdminHeaders(token),
      }),
      busStats: await requestJson(`${harness.messageBusUrl}/stats`, {
        headers: {
          Authorization: `Bearer ${harness.busApiKey}`,
        },
      }),
    }

    const backupDir = path.join(harness.tempRoot, 'backups')
    await mkdir(backupDir, { recursive: true })
    const directoryBackupPath = path.join(backupDir, 'beam-directory.sqlite')
    const busBackupPath = path.join(backupDir, 'beam-message-bus.sqlite')

    await copySqliteSnapshot(harness.directoryDbPath, directoryBackupPath)
    await copySqliteSnapshot(harness.messageBusDbPath, busBackupPath)

    const backupChecksums = {
      directory: await checksumSqliteSnapshot(directoryBackupPath),
      messageBus: await checksumSqliteSnapshot(busBackupPath),
    }

    await harness.stopServices()

    await corruptSqliteSnapshot(harness.directoryDbPath, 'directory-db')
    await corruptSqliteSnapshot(harness.messageBusDbPath, 'message-bus-db')

    await copySqliteSnapshot(directoryBackupPath, harness.directoryDbPath)
    await copySqliteSnapshot(busBackupPath, harness.messageBusDbPath)

    const restoredChecksums = {
      directory: await checksumSqliteSnapshot(harness.directoryDbPath),
      messageBus: await checksumSqliteSnapshot(harness.messageBusDbPath),
    }

    await harness.startServices()

    const restoredToken = await harness.createAdminToken()
    const postRestore = {
      parity: await fetchReleaseParity(harness.directoryUrl),
      requests: await requestJson(`${harness.directoryUrl}/admin/beta-requests`, {
        headers: createAdminHeaders(restoredToken),
      }),
      requestDetail: await requestJson(`${harness.directoryUrl}/admin/beta-requests/${created.request.id}`, {
        headers: { Authorization: `Bearer ${restoredToken}` },
      }),
      partnerHealth: await requestJson(`${harness.directoryUrl}/admin/partner-health`, {
        headers: createAdminHeaders(restoredToken),
      }),
      busStats: await requestJson(`${harness.messageBusUrl}/stats`, {
        headers: {
          Authorization: `Bearer ${harness.busApiKey}`,
        },
      }),
    }
    const snapshotRestored = JSON.stringify(backupChecksums.directory) === JSON.stringify(restoredChecksums.directory)
      && JSON.stringify(backupChecksums.messageBus) === JSON.stringify(restoredChecksums.messageBus)

    if (!preRestore.parity.consistent || !postRestore.parity.consistent) {
      throw new Error('Release truth drift detected during backup/restore drill.')
    }
    if (preRestore.requestDetail.request.id !== postRestore.requestDetail.request.id) {
      throw new Error('Recovered beta request id changed across restore.')
    }
    if (preRestore.requestDetail.request.status !== postRestore.requestDetail.request.status) {
      throw new Error('Recovered beta request status changed across restore.')
    }
    if (preRestore.requestDetail.request.proofIntentNonce !== postRestore.requestDetail.request.proofIntentNonce) {
      throw new Error('Recovered beta request proof nonce changed across restore.')
    }
    if (preRestore.requestDetail.request.owner !== postRestore.requestDetail.request.owner) {
      throw new Error('Recovered beta request owner changed across restore.')
    }
    if (preRestore.busStats.total !== postRestore.busStats.total) {
      throw new Error('Message bus totals changed across restore.')
    }
    if (!snapshotRestored) {
      throw new Error('Restored database checksum did not match the backup snapshot.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      backupChecksums,
      restoredChecksums,
      preRestore: {
        requestId: preRestore.requestDetail.request.id,
        requestStatus: preRestore.requestDetail.request.status,
        requestOwner: preRestore.requestDetail.request.owner,
        proofIntentNonce: preRestore.requestDetail.request.proofIntentNonce,
        activePartnerHealth: preRestore.partnerHealth.summary.activeRequests,
        busStats: preRestore.busStats,
      },
      postRestore: {
        requestId: postRestore.requestDetail.request.id,
        requestStatus: postRestore.requestDetail.request.status,
        requestOwner: postRestore.requestDetail.request.owner,
        proofIntentNonce: postRestore.requestDetail.request.proofIntentNonce,
        activePartnerHealth: postRestore.partnerHealth.summary.activeRequests,
        busStats: postRestore.busStats,
      },
    }

    const markdown = `# Beam 1.0.0 Recovery Drill

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local production harness

## Result

\`PASS\`

## Steps

1. Seeded one production-like partner request and two message-bus records.
2. Captured release truth, partner queue, partner health, and bus stats before backup.
3. Copied the directory and message-bus SQLite files into a backup directory.
4. Stopped services, corrupted the live database files, restored the snapshots, and restarted the services.
5. Re-ran release truth, partner queue, partner health, and bus stats after restore.

## Verification

- Release truth consistent before restore: \`${preRestore.parity.consistent}\`
- Release truth consistent after restore: \`${postRestore.parity.consistent}\`
- Request id preserved: \`${preRestore.requestDetail.request.id} -> ${postRestore.requestDetail.request.id}\`
- Request status preserved: \`${preRestore.requestDetail.request.status} -> ${postRestore.requestDetail.request.status}\`
- Proof nonce preserved: \`${preRestore.requestDetail.request.proofIntentNonce} -> ${postRestore.requestDetail.request.proofIntentNonce}\`
- Bus total preserved: \`${preRestore.busStats.total} -> ${postRestore.busStats.total}\`
- Directory snapshot restored: \`${JSON.stringify(backupChecksums.directory) === JSON.stringify(restoredChecksums.directory)}\`
- Message-bus snapshot restored: \`${JSON.stringify(backupChecksums.messageBus) === JSON.stringify(restoredChecksums.messageBus)}\`

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
  console.error('[production:backup-restore] failed:', error)
  process.exitCode = 1
})
