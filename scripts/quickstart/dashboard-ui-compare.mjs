import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const defaultRoot = path.join(repoRoot, 'tmp/dashboard-ui-smoke')
const defaultBaselineDir = path.join(repoRoot, 'spec/visual/dashboard-baselines')
const baselineKeys = ['loginDesktop', 'fleetDesktop', 'workspaceDesktop', 'intentsDesktop', 'traceDesktop']
const maxDiffRatio = Number.parseFloat(process.env.BEAM_UI_BASELINE_MAX_DIFF_RATIO ?? '0.08')

function optionalFlag(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const next = process.argv[index + 1]
  if (!next || next.startsWith('--')) return fallback
  return next
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
      // continue
    }
  }

  throw new Error(`No dashboard UI smoke summary found under ${rootDir}`)
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`
}

async function readPng(filePath) {
  const buffer = await readFile(filePath)
  return PNG.sync.read(buffer)
}

async function main() {
  const summaryFlag = optionalFlag('--summary')
  const rootDir = optionalFlag('--root', defaultRoot)
  const baselineDir = path.resolve(optionalFlag('--baseline-dir', defaultBaselineDir))
  const summaryPath = summaryFlag ? path.resolve(summaryFlag) : await findLatestSummary(rootDir)
  const outputDir = path.resolve(optionalFlag('--output', path.join(path.dirname(summaryPath), 'compare')))
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
  const manifest = JSON.parse(await readFile(path.join(baselineDir, 'manifest.json'), 'utf8'))

  await mkdir(outputDir, { recursive: true })

  const comparisons = []
  let failed = false

  for (const key of baselineKeys) {
    const baselineFilename = manifest.pages?.[key]
    const candidatePath = summary.pages?.[key]
    if (typeof baselineFilename !== 'string' || typeof candidatePath !== 'string') {
      throw new Error(`Missing baseline or candidate image for ${key}`)
    }

    const baselinePath = path.join(baselineDir, baselineFilename)
    const baselineImage = await readPng(baselinePath)
    const candidateImage = await readPng(candidatePath)

    if (baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) {
      throw new Error(`Image dimensions changed for ${key}: baseline ${baselineImage.width}x${baselineImage.height}, candidate ${candidateImage.width}x${candidateImage.height}`)
    }

    const diff = new PNG({ width: baselineImage.width, height: baselineImage.height })
    const changedPixels = pixelmatch(
      baselineImage.data,
      candidateImage.data,
      diff.data,
      baselineImage.width,
      baselineImage.height,
      { threshold: 0.18, includeAA: false },
    )
    const totalPixels = baselineImage.width * baselineImage.height
    const diffRatio = totalPixels > 0 ? changedPixels / totalPixels : 0
    const passed = diffRatio <= maxDiffRatio
    failed ||= !passed

    const diffPath = path.join(outputDir, `${key}-diff.png`)
    if (!passed || changedPixels > 0) {
      await writeFile(diffPath, PNG.sync.write(diff))
    }

    comparisons.push({
      key,
      baselinePath,
      candidatePath,
      diffPath: changedPixels > 0 ? diffPath : null,
      changedPixels,
      totalPixels,
      diffRatio,
      passed,
    })
  }

  const report = [
    '# Dashboard UI Visual Regression',
    '',
    `- Summary: \`${summaryPath}\``,
    `- Baseline: \`${baselineDir}\``,
    `- Allowed diff ratio: \`${formatPercent(maxDiffRatio)}\``,
    '',
    '## Pages',
    '',
    ...comparisons.map((comparison) =>
      `- \`${comparison.key}\`: ${comparison.passed ? 'PASS' : 'FAIL'} · changed \`${comparison.changedPixels}\` / \`${comparison.totalPixels}\` · ratio \`${formatPercent(comparison.diffRatio)}\`${comparison.diffPath ? ` · diff \`${path.basename(comparison.diffPath)}\`` : ''}`,
    ),
    '',
  ].join('\n')

  const summaryOutput = {
    ok: !failed,
    summaryPath,
    baselineDir,
    outputDir,
    maxDiffRatio,
    comparisons,
  }

  await writeFile(path.join(outputDir, 'report.md'), `${report}\n`, 'utf8')
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summaryOutput, null, 2)}\n`, 'utf8')

  if (failed) {
    console.error(report)
    process.exit(1)
  }

  process.stdout.write(`${report}\n`)
}

main().catch((error) => {
  console.error('[dashboard-ui-compare] failed:', error)
  process.exit(1)
})
