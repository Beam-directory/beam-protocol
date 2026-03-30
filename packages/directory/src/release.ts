import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../')
const rootPackageJsonPath = resolve(repoRoot, 'package.json')
const directoryPackageJsonPath = resolve(__dirname, '../package.json')
const gitRootPath = resolve(repoRoot, '.git')

export type ReleaseInfo = {
  version: string
  gitSha: string | null
  gitShaShort: string | null
  deployedAt: string
}

function readPackageVersion(): string {
  for (const path of [rootPackageJsonPath, directoryPackageJsonPath]) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
      if (typeof raw.version === 'string' && raw.version.trim().length > 0) {
        return raw.version.trim()
      }
    } catch {
      // Try the next package source.
    }
  }

  return '0.0.0-dev'
}

function normalizeSha(value: string | undefined | null): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null
}

function resolveGitDir(candidate: string): string | null {
  try {
    if (!existsSync(candidate)) {
      return null
    }

    const statLike = readFileSync(candidate, 'utf8')
    if (statLike.startsWith('gitdir:')) {
      const relativeGitDir = statLike.slice('gitdir:'.length).trim()
      return resolve(dirname(candidate), relativeGitDir)
    }
  } catch {
    // .git may be a directory, not a file.
  }

  return candidate
}

function readPackedRef(gitDir: string, ref: string): string | null {
  try {
    const packedRefs = readFileSync(resolve(gitDir, 'packed-refs'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('^'))

    for (const line of packedRefs) {
      const [sha, refName] = line.split(' ')
      if (refName === ref) {
        return normalizeSha(sha)
      }
    }
  } catch {
    // packed-refs is optional.
  }

  return null
}

function readGitShaFromRepo(): string | null {
  const gitDir = resolveGitDir(gitRootPath)
  if (!gitDir) {
    return null
  }

  try {
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice('ref:'.length).trim()
      const refPath = resolve(gitDir, ref)
      if (existsSync(refPath)) {
        return normalizeSha(readFileSync(refPath, 'utf8'))
      }

      return readPackedRef(gitDir, ref)
    }

    return normalizeSha(head)
  } catch {
    return null
  }
}

function readGitSha(): string | null {
  const fromEnv = normalizeSha(
    process.env['BEAM_RELEASE_SHA']
      ?? process.env['VERCEL_GIT_COMMIT_SHA']
      ?? process.env['SOURCE_VERSION']
      ?? process.env['GITHUB_SHA']
      ?? null,
  )

  return fromEnv ?? readGitShaFromRepo()
}

function readDeployedAt(startedAtMs: number): string {
  const candidate = (
    process.env['BEAM_DEPLOYED_AT']
      ?? process.env['VERCEL_DEPLOYMENT_CREATED_AT']
      ?? process.env['DEPLOYED_AT']
      ?? null
  )

  if (candidate) {
    const parsed = new Date(candidate)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }

  return new Date(startedAtMs).toISOString()
}

export function getReleaseInfo(startedAtMs: number): ReleaseInfo {
  const version = (process.env['BEAM_RELEASE_VERSION'] ?? readPackageVersion()).trim()
  const gitSha = readGitSha()

  return {
    version,
    gitSha,
    gitShaShort: gitSha ? gitSha.slice(0, 7) : null,
    deployedAt: readDeployedAt(startedAtMs),
  }
}
