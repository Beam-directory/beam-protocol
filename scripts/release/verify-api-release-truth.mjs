function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function requiredFlag(name) {
  const value = readFlag(name)
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing required flag: ${name}`)
  }
  return value.trim()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`)
  }
  return response.json()
}

async function main() {
  const baseUrl = requiredFlag('--base-url').replace(/\/+$/, '')
  const expectedVersion = requiredFlag('--version')
  const expectedGitSha = requiredFlag('--git-sha')
  const expectedDeployedAt = requiredFlag('--deployed-at')
  const retries = Number.parseInt(readFlag('--retries', '20'), 10)
  const delayMs = Number.parseInt(readFlag('--delay-ms', '5000'), 10)

  let lastError = null

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const [health, stats, releasePayload] = await Promise.all([
        fetchJson(`${baseUrl}/health`),
        fetchJson(`${baseUrl}/stats`),
        fetchJson(`${baseUrl}/release`),
      ])

      const healthRelease = normalizeRelease(health)
      const statsRelease = normalizeRelease(stats)
      const release = normalizeRelease(releasePayload)

      for (const [name, candidate] of [
        ['health', healthRelease],
        ['stats', statsRelease],
        ['release', release],
      ]) {
        if (!candidate) {
          throw new Error(`Missing release payload on ${name}`)
        }

        if (candidate.version !== expectedVersion) {
          throw new Error(`${name} version mismatch: ${candidate.version} !== ${expectedVersion}`)
        }

        if (candidate.gitSha !== expectedGitSha) {
          throw new Error(`${name} gitSha mismatch: ${candidate.gitSha} !== ${expectedGitSha}`)
        }

        if (candidate.deployedAt !== expectedDeployedAt) {
          throw new Error(`${name} deployedAt mismatch: ${candidate.deployedAt} !== ${expectedDeployedAt}`)
        }
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            baseUrl,
            release: healthRelease,
            attempts: attempt,
          },
          null,
          2,
        ),
      )
      return
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await sleep(delayMs)
        continue
      }
    }
  }

  throw lastError ?? new Error('Release truth verification failed')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
