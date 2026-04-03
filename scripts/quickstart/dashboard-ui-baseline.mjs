import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const defaultRoot = path.join(repoRoot, 'tmp/dashboard-ui-smoke')
const defaultBaselineDir = path.join(repoRoot, 'spec/visual/dashboard-baselines')
const baselineKeys = ['loginDesktop', 'fleetDesktop', 'workspaceDesktop', 'intentsDesktop', 'traceDesktop']

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
      // keep scanning
    }
  }

  throw new Error(`No dashboard UI smoke summary found under ${rootDir}`)
}

async function main() {
  const summaryFlag = optionalFlag('--summary')
  const rootDir = optionalFlag('--root', defaultRoot)
  const baselineDir = path.resolve(optionalFlag('--baseline-dir', defaultBaselineDir))
  const summaryPath = summaryFlag ? path.resolve(summaryFlag) : await findLatestSummary(rootDir)
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'))

  await mkdir(baselineDir, { recursive: true })

  const pages = {}
  for (const key of baselineKeys) {
    const source = summary.pages?.[key]
    if (typeof source !== 'string' || !source) {
      throw new Error(`Missing screenshot for ${key} in ${summaryPath}`)
    }
    const filename = `${key}.png`
    const target = path.join(baselineDir, filename)
    await cp(source, target)
    pages[key] = filename
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: summary.generatedAt ?? null,
    sourceSummaryPath: summaryPath,
    sourceOutputDir: summary.outputDir ?? null,
    pages,
  }

  await writeFile(path.join(baselineDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${baselineDir}\n`)
}

main().catch((error) => {
  console.error('[dashboard-ui-baseline] failed:', error)
  process.exit(1)
})
