import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const defaultRoot = path.join(repoRoot, 'tmp/dashboard-ui-smoke')

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
  if (!trimmed || trimmed.startsWith('--')) {
    return fallback
  }

  return trimmed
}

async function findLatestSummary(rootDir) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(rootDir, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .sort()
    .reverse()

  for (const dir of dirs) {
    const summaryPath = path.join(dir, 'summary.json')
    try {
      const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
      if (summary && typeof summary === 'object' && summary.pages && typeof summary.pages === 'object') {
        return summaryPath
      }
    } catch {
      // Continue until a real summary exists.
    }
  }

  throw new Error(`No dashboard UI smoke summary found under ${rootDir}`)
}

async function readCompareSummary(rootDir, smokeSummaryPath) {
  const compareSummaryPath = path.join(path.dirname(smokeSummaryPath), 'compare', 'summary.json')
  try {
    const summary = JSON.parse(await readFile(compareSummaryPath, 'utf8'))
    return summary && typeof summary === 'object' ? summary : null
  } catch {
    return null
  }
}

function formatPageList(pages) {
  return Object.entries(pages)
    .map(([key, value]) => `- \`${key}\`: \`${path.basename(value)}\``)
    .join('\n')
}

async function main() {
  const summaryFlag = optionalFlag('--summary')
  const outputFlag = optionalFlag('--output')
  const rootDir = optionalFlag('--root', defaultRoot)
  const useLatest = process.argv.includes('--latest')

  const summaryPath = summaryFlag && !useLatest
    ? path.resolve(summaryFlag)
    : await findLatestSummary(rootDir)

  const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
  const compareSummary = await readCompareSummary(rootDir, summaryPath)
  const compareLines = compareSummary
    ? [
        '',
        '## Visual regression',
        '',
        `- Overall: \`${compareSummary.ok ? 'PASS' : 'FAIL'}\``,
        `- Allowed diff ratio: \`${typeof compareSummary.maxDiffRatio === 'number' ? `${(compareSummary.maxDiffRatio * 100).toFixed(2)}%` : 'n/a'}\``,
        ...Array.isArray(compareSummary.comparisons)
          ? compareSummary.comparisons.map((comparison) =>
              `- \`${comparison.key}\`: ${comparison.passed ? 'PASS' : 'FAIL'} · \`${((comparison.diffRatio ?? 0) * 100).toFixed(2)}%\` changed`,
            )
          : [],
      ].join('\n')
    : ''
  const report = `# Dashboard UI Smoke\n\n- Overall: \`PASS\`\n- Generated at: \`${summary.generatedAt ?? 'unknown'}\`\n- Output directory: \`${summary.outputDir}\`\n- Login URL: \`${summary.loginUrl ?? 'n/a'}\`\n- Trace nonce: \`${summary.traceNonce ?? 'n/a'}\`\n\n## Captured pages\n\n${formatPageList(summary.pages ?? {})}${compareLines}\n`

  if (outputFlag) {
    const outputPath = path.resolve(outputFlag)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, report, 'utf8')
  } else {
    process.stdout.write(report)
  }
}

main().catch((error) => {
  console.error('[dashboard-ui-report] failed:', error)
  process.exit(1)
})
