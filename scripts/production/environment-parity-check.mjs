import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, requestJson, requestText, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const apiBase = optionalFlag('--api-base', 'https://api.beam.directory')
const siteBase = optionalFlag('--site-base', 'https://beam.directory')
const docsUrl = optionalFlag('--docs-url', 'https://docs.beam.directory/guide/production-partner-workflow')
const outputPath = optionalFlag('--output')

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

async function main() {
  const [health, stats, release, statusPage, docs] = await Promise.all([
    requestJson(`${apiBase}/health`),
    requestJson(`${apiBase}/stats`),
    requestJson(`${apiBase}/release`),
    requestText(`${siteBase}/status.html`),
    requestText(docsUrl),
  ])

  const normalizedHealth = normalizeRelease(health)
  const normalizedStats = normalizeRelease(stats)
  const normalizedRelease = normalizeRelease(release)
  const releaseTruthConsistent = JSON.stringify(normalizedHealth) === JSON.stringify(normalizedStats)
    && JSON.stringify(normalizedHealth) === JSON.stringify(normalizedRelease)

  if (!releaseTruthConsistent) {
    throw new Error('Release truth drift detected across /health, /stats, and /release.')
  }

  const statusMentionsApi = statusPage.text.includes(`${apiBase}/health`) && statusPage.text.includes(`${apiBase}/stats`)
  if (!statusMentionsApi) {
    throw new Error('Public status page does not reference the current API base URLs.')
  }

  const result = {
    ok: true,
    date: formatDate(),
    apiBase,
    siteBase,
    docsUrl,
    release: normalizedRelease,
    statusMentionsApi,
  }

  if (outputPath) {
    const markdown = `# Beam Environment Parity Check

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- api base: \`${apiBase}\`
- site base: \`${siteBase}\`

## Result

\`PASS\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(path.resolve(outputPath), markdown)
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error('[production:parity] failed:', error)
  process.exitCode = 1
})
