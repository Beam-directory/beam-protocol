import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getReleaseInfo } from './release.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const releaseMetadataPath = resolve(__dirname, '../release.json')
const releaseEnvKeys = [
  'BEAM_RELEASE_VERSION',
  'BEAM_RELEASE_SHA',
  'BEAM_DEPLOYED_AT',
  'VERCEL_GIT_COMMIT_SHA',
  'SOURCE_VERSION',
  'GITHUB_SHA',
  'VERCEL_DEPLOYMENT_CREATED_AT',
  'DEPLOYED_AT',
] as const

type ReleaseEnvKey = (typeof releaseEnvKeys)[number]

function restoreReleaseMetadata(originalContents: string | null) {
  if (originalContents === null) {
    writeFileSync(
      releaseMetadataPath,
      JSON.stringify(
        {
          version: null,
          gitSha: null,
          deployedAt: null,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  writeFileSync(releaseMetadataPath, originalContents)
}

function snapshotReleaseEnv(): Record<ReleaseEnvKey, string | undefined> {
  return Object.fromEntries(releaseEnvKeys.map((key) => [key, process.env[key]])) as Record<ReleaseEnvKey, string | undefined>
}

function clearReleaseEnv() {
  for (const key of releaseEnvKeys) {
    delete process.env[key]
  }
}

function restoreReleaseEnv(snapshot: Record<ReleaseEnvKey, string | undefined>) {
  for (const key of releaseEnvKeys) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}

test('getReleaseInfo reads directory release metadata file when env is absent', () => {
  const originalContents = existsSync(releaseMetadataPath) ? readFileSync(releaseMetadataPath, 'utf8') : null
  const originalEnv = snapshotReleaseEnv()

  try {
    clearReleaseEnv()

    writeFileSync(
      releaseMetadataPath,
      JSON.stringify(
        {
          version: '0.8.1-test',
          gitSha: '1234567890abcdef1234567890abcdef12345678',
          deployedAt: '2026-03-31T08:15:00.000Z',
        },
        null,
        2,
      ) + '\n',
    )

    const release = getReleaseInfo(0)
    assert.equal(release.version, '0.8.1-test')
    assert.equal(release.gitSha, '1234567890abcdef1234567890abcdef12345678')
    assert.equal(release.gitShaShort, '1234567')
    assert.equal(release.deployedAt, '2026-03-31T08:15:00.000Z')
  } finally {
    restoreReleaseMetadata(originalContents)
    restoreReleaseEnv(originalEnv)
  }
})

test('getReleaseInfo lets env overrides win over release metadata file', () => {
  const originalContents = existsSync(releaseMetadataPath) ? readFileSync(releaseMetadataPath, 'utf8') : null
  const originalEnv = snapshotReleaseEnv()

  try {
    clearReleaseEnv()

    writeFileSync(
      releaseMetadataPath,
      JSON.stringify(
        {
          version: '0.8.1-file',
          gitSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
          deployedAt: '2026-03-31T08:20:00.000Z',
        },
        null,
        2,
      ) + '\n',
    )

    process.env['BEAM_RELEASE_VERSION'] = '0.8.1-env'
    process.env['BEAM_RELEASE_SHA'] = 'fedcba9876543210fedcba9876543210fedcba98'
    process.env['BEAM_DEPLOYED_AT'] = '2026-03-31T08:25:00.000Z'

    const release = getReleaseInfo(0)
    assert.equal(release.version, '0.8.1-env')
    assert.equal(release.gitSha, 'fedcba9876543210fedcba9876543210fedcba98')
    assert.equal(release.gitShaShort, 'fedcba9')
    assert.equal(release.deployedAt, '2026-03-31T08:25:00.000Z')
  } finally {
    restoreReleaseMetadata(originalContents)
    restoreReleaseEnv(originalEnv)
  }
})
