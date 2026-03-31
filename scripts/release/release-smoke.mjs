import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../')

const rootPackageJson = readJson(resolve(repoRoot, 'package.json'))
const sdkPackageJson = readJson(resolve(repoRoot, 'packages/sdk-typescript/package.json'))
const cliPackageJson = readJson(resolve(repoRoot, 'packages/cli/package.json'))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function optionalFlag(name, fallback = null) {
  const value = readFlag(name, fallback)
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.startsWith('--')) {
    return fallback
  }

  return trimmed
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, '')
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

function releasesMatch(left, right) {
  return left.version === right.version
    && left.gitSha === right.gitSha
    && left.deployedAt === right.deployedAt
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`)
  }

  return {
    url: response.url,
    status: response.status,
    body: await response.json(),
  }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`)
  }

  return {
    url: response.url,
    status: response.status,
    body: await response.text(),
  }
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`)
  }
}

async function verifyApi(apiBaseUrl, expectedVersion, expectedGitSha) {
  const [healthResponse, statsResponse, releaseResponse] = await Promise.all([
    fetchJson(`${apiBaseUrl}/health`),
    fetchJson(`${apiBaseUrl}/stats`),
    fetchJson(`${apiBaseUrl}/release`),
  ])

  const healthRelease = normalizeRelease(healthResponse.body)
  const statsRelease = normalizeRelease(statsResponse.body)
  const release = normalizeRelease(releaseResponse.body)

  for (const [name, candidate] of [
    ['health', healthRelease],
    ['stats', statsRelease],
    ['release', release],
  ]) {
    if (!candidate) {
      throw new Error(`Missing release payload on ${name}`)
    }
  }

  if (!releasesMatch(healthRelease, statsRelease) || !releasesMatch(healthRelease, release)) {
    throw new Error('API release truth drift detected across /health, /stats, and /release')
  }

  if (expectedVersion && healthRelease.version !== expectedVersion) {
    throw new Error(`API version mismatch: ${healthRelease.version} !== ${expectedVersion}`)
  }

  if (expectedGitSha && healthRelease.gitSha !== expectedGitSha) {
    throw new Error(`API git SHA mismatch: ${healthRelease.gitSha} !== ${expectedGitSha}`)
  }

  return {
    release: healthRelease,
    healthStatus: healthResponse.body.status ?? null,
    connectedAgents: healthResponse.body.connectedAgents ?? null,
    uptimeSeconds: healthResponse.body.uptimeSeconds ?? null,
  }
}

async function verifyPublicSite(siteBaseUrl) {
  const [homeResponse, hostedBetaResponse, statusResponse] = await Promise.all([
    fetchText(`${siteBaseUrl}/`),
    fetchText(`${siteBaseUrl}/hosted-beta.html`),
    fetchText(`${siteBaseUrl}/status.html`),
  ])

  assertIncludes(homeResponse.body, '<title>Beam | Safe AI Work Between Companies</title>', 'public-site home title')
  assertIncludes(homeResponse.body, 'Request hosted beta', 'public-site primary CTA')
  assertIncludes(hostedBetaResponse.body, '<title>Request a Guided Beam Pilot', 'hosted-beta title')
  assertIncludes(hostedBetaResponse.body, 'Request hosted beta', 'hosted-beta submit CTA')
  assertIncludes(statusResponse.body, 'Beam Directory Status', 'status page title')
  assertIncludes(statusResponse.body, 'https://api.beam.directory/health', 'status health endpoint proof')
  assertIncludes(statusResponse.body, 'https://api.beam.directory/stats', 'status stats endpoint proof')

  return {
    homeUrl: homeResponse.url,
    hostedBetaUrl: hostedBetaResponse.url,
    statusUrl: statusResponse.url,
  }
}

async function verifyDocs(docsUrl) {
  const docsResponse = await fetchText(docsUrl)
  assertIncludes(docsResponse.body, '<title>Hosted Quickstart | Beam Protocol</title>', 'docs hosted-quickstart title')
  assertIncludes(docsResponse.body, 'ops/quickstart/compose.yaml', 'docs quickstart compose marker')

  return {
    url: docsResponse.url,
  }
}

async function verifyNpmPackages(expectedVersion) {
  const packages = [
    { name: sdkPackageJson.name, expectedVersion: sdkPackageJson.version },
    { name: cliPackageJson.name, expectedVersion: cliPackageJson.version },
  ]

  const results = []
  for (const pkg of packages) {
    const response = await fetchJson(`https://registry.npmjs.org/${pkg.name}/latest`)
    const publishedVersion = typeof response.body.version === 'string' ? response.body.version : null
    if (!publishedVersion) {
      throw new Error(`Missing npm version for ${pkg.name}`)
    }

    const expected = expectedVersion ?? pkg.expectedVersion
    if (publishedVersion !== expected) {
      throw new Error(`npm version mismatch for ${pkg.name}: ${publishedVersion} !== ${expected}`)
    }

    results.push({
      name: pkg.name,
      version: publishedVersion,
    })
  }

  return results
}

function toMarkdown(result) {
  const generatedAt = new Date().toISOString()
  const api = result.api
  const npmPackages = result.npmPackages
    .map((pkg) => `- \`${pkg.name}\`: \`${pkg.version}\``)
    .join('\n')

  return `# Beam Release Smoke — ${result.expectedVersion ?? api.release.version ?? 'unknown'}

- Generated at: \`${generatedAt}\`
- Overall: \`PASS\`

## API Release Truth

- Base URL: \`${result.apiBaseUrl}\`
- Version: \`${api.release.version}\`
- Git SHA: \`${api.release.gitSha ?? 'n/a'}\`
- Deployed at: \`${api.release.deployedAt ?? 'n/a'}\`
- Health status: \`${api.healthStatus ?? 'unknown'}\`
- Connected agents: \`${api.connectedAgents ?? 'n/a'}\`

## Public Site Proof

- Home: \`${result.publicSite.homeUrl}\`
- Hosted beta: \`${result.publicSite.hostedBetaUrl}\`
- Status page: \`${result.publicSite.statusUrl}\`

## Docs Freshness

- Hosted Quickstart: \`${result.docs.url}\`

## npm Packages

${npmPackages}
`
}

async function main() {
  const expectedVersion = optionalFlag('--version', rootPackageJson.version)
  const expectedGitSha = optionalFlag('--git-sha')
  const apiBaseUrl = normalizeBaseUrl(optionalFlag('--api-base', 'https://api.beam.directory'))
  const siteBaseUrl = normalizeBaseUrl(optionalFlag('--site-base', 'https://beam.directory'))
  const docsUrl = optionalFlag('--docs-url', 'https://docs.beam.directory/guide/hosted-quickstart')
  const outputPath = optionalFlag('--output')

  const [api, publicSite, docs, npmPackages] = await Promise.all([
    verifyApi(apiBaseUrl, expectedVersion, expectedGitSha),
    verifyPublicSite(siteBaseUrl),
    verifyDocs(docsUrl),
    verifyNpmPackages(expectedVersion),
  ])

  const result = {
    ok: true,
    expectedVersion,
    expectedGitSha,
    apiBaseUrl,
    siteBaseUrl,
    docsUrl,
    api,
    publicSite,
    docs,
    npmPackages,
  }

  if (outputPath) {
    writeFileSync(resolve(repoRoot, outputPath), toMarkdown(result))
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
