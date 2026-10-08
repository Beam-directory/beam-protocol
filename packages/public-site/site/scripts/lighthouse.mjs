/**
 * Runs Lighthouse 12 sequentially against `vite preview` (production build) and prints a score table.
 *
 *   npx vite preview --port 4317   # in another terminal
 *   node scripts/lighthouse.mjs [baseUrl]
 *
 * Reports are written to .lighthouse/ (git-ignored).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(siteRoot, '.lighthouse')
mkdirSync(outDir, { recursive: true })
const base = process.argv[2] ?? 'http://localhost:4317'
const pages = [['home-en', '/'], ['verify-en', '/verify'], ['start-en', '/start'], ['home-de', '/de'], ['verify-de', '/de/verify'], ['start-de', '/de/start']]
const presets = ['mobile', 'desktop']
const categories = ['performance', 'accessibility', 'best-practices', 'seo']

const rows = []
for (const [name, route] of pages) {
  for (const preset of presets) {
    const file = path.join(outDir, `${name}-${preset}.json`)
    const args = [
      '--yes', 'lighthouse@12', `${base}${route}`, '--quiet', '--chrome-flags=--headless=new',
      `--only-categories=${categories.join(',')}`, '--output=json', `--output-path=${file}`,
    ]
    if (preset === 'desktop') args.push('--preset=desktop')
    execFileSync('npx', args, { stdio: 'inherit' })
    const report = JSON.parse(readFileSync(file, 'utf8'))
    const scores = categories.map((key) => Math.round((report.categories[key]?.score ?? 0) * 100))
    const failing = Object.values(report.audits)
      .filter((audit) => audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== 'informative' && audit.scoreDisplayMode !== 'notApplicable' && audit.scoreDisplayMode !== 'manual')
      .map((audit) => `${audit.id}(${audit.score})`)
    rows.push({ page: route, preset, scores, failing })
  }
}

console.log(`\n| Page | Preset | ${categories.join(' | ')} |`)
console.log(`|---|---|${categories.map(() => '---').join('|')}|`)
for (const row of rows) console.log(`| ${row.page} | ${row.preset} | ${row.scores.join(' | ')} |`)
console.log('\nAudits below 0.9:')
for (const row of rows) console.log(`${row.page} ${row.preset}: ${row.failing.join(', ') || 'none'}`)
