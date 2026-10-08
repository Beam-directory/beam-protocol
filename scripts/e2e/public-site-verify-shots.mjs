/**
 * Screenshots of the production public-site build against the live directory.
 * Not part of CI. Requires the site to be built without VITE_DIRECTORY_* overrides.
 *
 *   node scripts/e2e/public-site-verify-shots.mjs [outputDir]
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { chromium } from 'playwright'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const siteRoot = path.join(repoRoot, 'packages/public-site/site')
const viteBin = path.join(repoRoot, 'node_modules/vite/bin/vite.js')
const outDir = path.join(siteRoot, 'dist')
const artifactDir = process.argv[2] ?? '/opt/cursor/artifacts/agent-trust-check'

const AGENTS = {
  verified: 'jarvis@coppen.beam.directory',
  'not-verified': 'booking@lufthansa.beam.directory',
}
const LOCALES = [
  ['en', '/verify'],
  ['de', '/de/verify'],
]
const THEMES = ['light', 'dark']
const VIEWPORTS = [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 844 }],
]

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const preview = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', outDir], {
  cwd: siteRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
preview.stdout?.on('data', (chunk) => { logs += chunk.toString() })
preview.stderr?.on('data', (chunk) => { logs += chunk.toString() })

async function ready() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/verify`)
      if (response.ok) return
    } catch { /* preview still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`preview did not start\n${logs}`)
}

await ready()
const browser = await chromium.launch()
try {
  for (const [locale, route] of LOCALES) {
    for (const theme of THEMES) {
      for (const [viewportName, viewport] of VIEWPORTS) {
        for (const [state, agent] of Object.entries(AGENTS)) {
          const context = await browser.newContext({ viewport, colorScheme: theme })
          await context.addInitScript((value) => localStorage.setItem('theme', value), theme)
          const page = await context.newPage()
          await page.goto(`${base}${route}?agent=${encodeURIComponent(agent)}`)
          await page.getByTestId('agent-check-headline').waitFor({ timeout: 25_000 })
          const file = path.join(artifactDir, `verify-${locale}-${theme}-${viewportName}-${state}.png`)
          await page.screenshot({ path: file })
          await context.close()
          console.log(file)
        }
        const context = await browser.newContext({ viewport, colorScheme: theme })
        await context.addInitScript((value) => localStorage.setItem('theme', value), theme)
        const page = await context.newPage()
        await page.goto(`${base}${route}?agent=${encodeURIComponent(AGENTS.verified)}`)
        await page.getByTestId('agent-check-headline').waitFor({ timeout: 25_000 })
        await page.getByTestId('agent-check-tamper').click()
        await page.getByTestId('agent-check-signature').filter({ hasText: locale === 'de' ? 'Byte' : 'byte' }).waitFor({ timeout: 25_000 })
        const file = path.join(artifactDir, `verify-${locale}-${theme}-${viewportName}-tampered.png`)
        await page.screenshot({ path: file })
        await context.close()
        console.log(file)
      }
    }
  }

  const videoContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: artifactDir, size: { width: 1280, height: 800 } },
  })
  await videoContext.addInitScript(() => localStorage.setItem('theme', 'light'))
  const videoPage = await videoContext.newPage()
  await videoPage.goto(`${base}/verify?agent=${encodeURIComponent(AGENTS.verified)}`)
  await videoPage.getByTestId('agent-check-headline').waitFor({ timeout: 25_000 })
  await videoPage.waitForTimeout(1200)
  await videoPage.getByTestId('agent-check-tamper').click()
  await videoPage.getByTestId('agent-check-signature').filter({ hasText: 'byte' }).waitFor({ timeout: 25_000 })
  await videoPage.waitForTimeout(800)
  const video = videoPage.video()
  await videoContext.close()
  if (video) {
    const saved = await video.path()
    console.log(saved)
  }
} finally {
  await browser.close()
  preview.kill('SIGTERM')
  await Promise.race([once(preview, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))])
  if (preview.exitCode === null) preview.kill('SIGKILL')
}
