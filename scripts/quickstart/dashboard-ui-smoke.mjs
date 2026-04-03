import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const envPath = path.join(repoRoot, 'ops/quickstart/.env')
const outputRoot = path.join(repoRoot, 'tmp/dashboard-ui-smoke')
const jsonOutput = process.argv.includes('--json')
const ADMIN_SESSION_STORAGE = 'beam-dashboard-admin-session-token'

function logStep(message) {
  if (!jsonOutput) {
    console.log(`[dashboard-ui-smoke] ${message}`)
  }
}

function parseEnvFile(raw) {
  const env = {}
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

async function loadQuickstartEnv() {
  try {
    const raw = await readFile(envPath, 'utf8')
    return parseEnvFile(raw)
  } catch {
    return {}
  }
}

function resolveRuntime(config) {
  const directoryPort = config.DIRECTORY_PORT ?? process.env.DIRECTORY_PORT ?? '43100'
  const dashboardPort = config.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? '43173'
  const messageBusPort = config.MESSAGE_BUS_PORT ?? process.env.MESSAGE_BUS_PORT ?? '43220'
  const demoAgentPort = config.DEMO_AGENT_PORT ?? process.env.DEMO_AGENT_PORT ?? '43290'
  const adminEmailList = config.BEAM_ADMIN_EMAILS ?? process.env.BEAM_ADMIN_EMAILS ?? 'ops@beam.local'
  const [adminEmail = 'ops@beam.local'] = adminEmailList
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    adminEmail,
    directoryUrl: `http://127.0.0.1:${directoryPort}`,
    dashboardUrl: `http://localhost:${dashboardPort}`,
    messageBusBaseUrl: `http://127.0.0.1:${messageBusPort}`,
    demoAgentUrl: `http://127.0.0.1:${demoAgentPort}`,
  }
}

async function waitForHealth(url, label, predicate = (response) => response.ok) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) {
        return response
      }
    } catch {
      // Wait until the service is up.
    }
    await sleep(500)
  }

  throw new Error(`${label} did not become ready at ${url}`)
}

async function waitForAuthedJson(url, token, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (response.ok) {
        return response
      }
    } catch {
      // Wait until the authenticated endpoint is ready.
    }
    await sleep(500)
  }

  throw new Error(`${label} did not become ready at ${url}`)
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  const payload = text.length > 0 ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`)
  }
  return payload
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    try {
      return await chromium.launch({
        channel: 'chrome',
        headless: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Playwright browser unavailable. Install Chromium with "npm run quickstart:ui-smoke:install" or ensure Google Chrome is installed. Underlying error: ${message}`)
    }
  }
}

async function captureLoginPage(browser, runtime, outputDir) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto(`${runtime.dashboardUrl}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Open the operator cockpit' }).waitFor()
  const screenshotPath = path.join(outputDir, 'login-desktop.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await context.close()
  return screenshotPath
}

async function createAuthedContext(browser, runtime, sessionToken, viewport) {
  const context = await browser.newContext({
    viewport,
    colorScheme: 'dark',
  })
  await context.addInitScript((token) => {
    window.localStorage.setItem('beam-dashboard-admin-session-token', token)
  }, sessionToken)
  return context
}

async function captureProtectedPage({
  context,
  runtime,
  route,
  selector,
  heading,
  bodyText,
  screenshotPath,
  timeoutMs = 20_000,
  fullPage = false,
  allowHeadingFallback = true,
}) {
  const page = await context.newPage()
  try {
    await page.goto(`${runtime.dashboardUrl}${route}`, { waitUntil: 'domcontentloaded' })

    let ready = false
    if (selector) {
      try {
        await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
        ready = true
      } catch {
        // Fall back to a page-specific heading when layout wrappers change.
      }
    }

    if (!ready && bodyText) {
      try {
        await page.getByText(bodyText, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs })
        ready = true
      } catch {
        // Fall back to the page heading when trace/body copy is still loading.
      }
    }

    if (!ready && heading && allowHeadingFallback) {
      await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ state: 'visible', timeout: timeoutMs })
      ready = true
    }

    if (!ready) {
      throw new Error(`Protected page ${route} never reached a ready state`)
    }

    await page.waitForTimeout(750)
    await page.screenshot({ path: screenshotPath, fullPage })
    return screenshotPath
  } catch (error) {
    const snippet = await page.locator('body').innerText().then((value) => value.slice(0, 800)).catch(() => '')
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(`Dashboard proof failed for ${route} at ${page.url()}: ${details}${snippet ? `\nBody snippet:\n${snippet}` : ''}`)
  } finally {
    await page.close()
  }
}

async function main() {
  const config = await loadQuickstartEnv()
  const runtime = resolveRuntime(config)
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const outputDir = path.join(outputRoot, timestamp)
  await mkdir(outputDir, { recursive: true })

  logStep('waiting for directory, dashboard, message bus, and hosted demo agents')
  await waitForHealth(`${runtime.directoryUrl}/health`, 'directory')
  await waitForHealth(`${runtime.messageBusBaseUrl}/health`, 'message bus')
  await waitForHealth(`${runtime.demoAgentUrl}/health`, 'demo agents')
  await waitForHealth(`${runtime.dashboardUrl}/login`, 'dashboard login')

  logStep('verifying local admin session')
  const challenge = await requestJson(`${runtime.directoryUrl}/admin/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: runtime.dashboardUrl,
    },
    body: JSON.stringify({ email: runtime.adminEmail }),
  })
  assert.equal(typeof challenge.token, 'string', 'local dev auth did not return a magic-link token')

  const verify = await requestJson(`${runtime.directoryUrl}/admin/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challenge.token }),
  })
  assert.equal(typeof verify.token, 'string', 'local dev auth did not return an admin session token')

  logStep('running canonical hosted trace for the trace detail page')
  await requestJson(`${runtime.demoAgentUrl}/demo/reseed`, {
    method: 'POST',
  })
  const run = await requestJson(`${runtime.demoAgentUrl}/demo/run`, {
    method: 'POST',
  })
  const traceNonce = run?.quote?.nonce
  assert.equal(typeof traceNonce, 'string', 'demo run did not return a quote nonce')
  await waitForAuthedJson(
    `${runtime.directoryUrl}/observability/intents/${encodeURIComponent(traceNonce)}`,
    verify.token,
    'trace detail',
  )

  logStep('capturing dashboard pages')
  const browser = await launchBrowser()
  try {
    const loginScreenshot = await captureLoginPage(browser, runtime, outputDir)
    const desktopContext = await createAuthedContext(browser, runtime, verify.token, { width: 1480, height: 1180 })
    const tabletContext = await createAuthedContext(browser, runtime, verify.token, { width: 1024, height: 1366 })
    const mobileContext = await createAuthedContext(browser, runtime, verify.token, { width: 430, height: 1080 })

    try {
      const screenshots = {
        loginDesktop: loginScreenshot,
        fleetDesktop: await captureProtectedPage({
          context: desktopContext,
          runtime,
          route: '/openclaw-fleet',
          selector: '[data-ui-page="openclaw-fleet"]',
          heading: 'OpenClaw Fleet',
          screenshotPath: path.join(outputDir, 'fleet-desktop.png'),
        }),
        workspaceDesktop: await captureProtectedPage({
          context: desktopContext,
          runtime,
          route: '/workspaces?workspace=openclaw-local',
          selector: '[data-ui-page="workspaces"]',
          heading: 'Workspaces',
          screenshotPath: path.join(outputDir, 'workspace-desktop.png'),
        }),
        intentsDesktop: await captureProtectedPage({
          context: desktopContext,
          runtime,
          route: '/intents',
          selector: '[data-ui-page="intents"]',
          heading: 'Intents',
          screenshotPath: path.join(outputDir, 'intents-desktop.png'),
        }),
        traceDesktop: await captureProtectedPage({
          context: desktopContext,
          runtime,
          route: `/intents/${encodeURIComponent(traceNonce)}`,
          bodyText: `Nonce ${traceNonce}`,
          heading: 'Trace',
          screenshotPath: path.join(outputDir, 'trace-desktop.png'),
          timeoutMs: 90_000,
          fullPage: false,
        }),
        fleetTablet: await captureProtectedPage({
          context: tabletContext,
          runtime,
          route: '/openclaw-fleet',
          selector: '[data-ui-page="openclaw-fleet"]',
          heading: 'OpenClaw Fleet',
          screenshotPath: path.join(outputDir, 'fleet-tablet.png'),
          fullPage: false,
        }),
        workspaceTablet: await captureProtectedPage({
          context: tabletContext,
          runtime,
          route: '/workspaces?workspace=openclaw-local',
          selector: '[data-ui-page="workspaces"]',
          heading: 'Workspaces',
          screenshotPath: path.join(outputDir, 'workspace-tablet.png'),
          fullPage: false,
        }),
        fleetMobile: await captureProtectedPage({
          context: mobileContext,
          runtime,
          route: '/openclaw-fleet',
          selector: '[data-ui-page="openclaw-fleet"]',
          heading: 'OpenClaw Fleet',
          screenshotPath: path.join(outputDir, 'fleet-mobile.png'),
          fullPage: false,
        }),
        workspaceMobile: await captureProtectedPage({
          context: mobileContext,
          runtime,
          route: '/workspaces?workspace=openclaw-local',
          selector: '[data-ui-page="workspaces"]',
          heading: 'Workspaces',
          screenshotPath: path.join(outputDir, 'workspace-mobile.png'),
          fullPage: false,
        }),
      }

      const summary = {
        ok: true,
        generatedAt: new Date().toISOString(),
        outputDir,
        loginUrl: challenge.url ?? `${runtime.dashboardUrl}/login`,
        pages: screenshots,
        traceNonce,
      }

      await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

      if (jsonOutput) {
        console.log(JSON.stringify(summary, null, 2))
      } else {
        console.log('')
        console.log('Dashboard UI smoke passed.')
        console.log(`Login:        ${summary.loginUrl}`)
        console.log(`Workspace:    ${runtime.dashboardUrl}/workspaces?workspace=openclaw-local`)
        console.log(`Fleet:        ${runtime.dashboardUrl}/openclaw-fleet`)
        console.log(`Trace nonce:  ${traceNonce}`)
        console.log(`Screenshots:  ${outputDir}`)
      }
    } finally {
      await Promise.all([
        desktopContext.close(),
        tabletContext.close(),
        mobileContext.close(),
      ])
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[dashboard-ui-smoke] smoke failed:', error)
  process.exit(1)
})
